import React, { useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { i18n } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import { statusColor, statusLabel, type RoadmapStatus } from './shared';

type DrawerTab = 'resources';

interface NodeCard {
  docId?: string;
  title?: string;
  problems?: Problem[];
}

function getNodeCards(nodeId: string): NodeCard[] {
  const map = ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, NodeCard[]>;
  return map[nodeId] || [];
}

function problemDisplayTitle(problem: Problem): string {
  const title = String(problem.title || '').trim();
  if (title) return title;
  const stem = String((problem as { stem?: string }).stem || '').trim();
  if (!stem) return i18n('Unnamed');
  return stem.replace(/<[^>]+>/g, '').slice(0, 80);
}

function problemKindI18nKey(type?: string): string {
  switch (type) {
    case 'multi': return 'Problem kind multi';
    case 'true_false': return 'Problem kind true false';
    case 'flip': return 'Problem kind flip';
    case 'fill_blank': return 'Problem kind fill blank';
    case 'matching': return 'Problem kind matching';
    case 'super_flip': return 'Problem kind super flip';
    case 'ai_eval': return 'Problem kind ai eval';
    default: return 'Problem kind single';
  }
}

function problemKindBadge(problem: Problem): string {
  return i18n(problemKindI18nKey(problem.type));
}

export function RoadmapNodeDrawer({
  open,
  nodeId,
  nodeLabel,
  nodeStatus,
  contentRef,
  onClose,
}: {
  open: boolean;
  nodeId: string;
  nodeLabel: string;
  nodeStatus?: RoadmapStatus;
  contentRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<DrawerTab>('resources');
  const problems = useMemo(() => {
    const cards = getNodeCards(nodeId);
    const list: Problem[] = [];
    cards.forEach((card) => {
      (card.problems || []).forEach((problem) => list.push(problem));
    });
    return list;
  }, [nodeId, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const status = nodeStatus || 'planned';

  return ReactDOM.createPortal(
    <>
      <div className="roadmap-detail-backdrop" aria-hidden />
      <aside className="roadmap-detail-drawer" aria-label={nodeLabel}>
        <div className="roadmap-detail-drawer__header">
          <div className="roadmap-detail-drawer__tabs">
            <button
              type="button"
              className={`roadmap-detail-drawer__tab${tab === 'resources' ? ' is-active' : ''}`}
              onClick={() => setTab('resources')}
            >
              {i18n('Roadmap drawer resources')}
            </button>
          </div>
          <div className="roadmap-detail-drawer__header-actions">
            <span
              className="roadmap-detail-drawer__status"
              style={{ '--roadmap-status-color': statusColor(status) } as React.CSSProperties}
            >
              <span className="roadmap-detail-drawer__status-dot" aria-hidden />
              {statusLabel(status)}
            </span>
            <button
              type="button"
              className="roadmap-detail-drawer__close"
              onClick={onClose}
              aria-label={i18n('Close')}
            >
              ×
            </button>
          </div>
        </div>

        <div className="roadmap-detail-drawer__body">
          <h1 className="roadmap-detail-drawer__title">{nodeLabel}</h1>
          <div ref={contentRef} className="roadmap-detail-drawer__markdown typo" />

          {problems.length > 0 ? (
            <section className="roadmap-detail-drawer__section">
              <h2 className="roadmap-detail-drawer__section-title">
                {i18n('Roadmap drawer practice problems')}
              </h2>
              <ul className="roadmap-detail-drawer__resource-list">
                {problems.map((problem) => (
                  <li key={problem.pid} className="roadmap-detail-drawer__resource-item">
                    <span className="roadmap-detail-drawer__resource-badge">
                      {problemKindBadge(problem)}
                    </span>
                    <span className="roadmap-detail-drawer__resource-label">
                      {problemDisplayTitle(problem)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

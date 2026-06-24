import React, { useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { i18n } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import { statusColor, statusLabel, type RoadmapStatus } from './shared';
import { RoadmapDrawerProblemList } from './RoadmapDrawerProblemList';
import { supportsRoadmapPracticeProblems } from './node_kinds';

type DrawerTab = 'content' | 'problems';

interface NodeCard {
  docId?: string;
  title?: string;
  problems?: Problem[];
}

function getNodeCards(nodeId: string): NodeCard[] {
  const map = ((window as any).UiContext?.nodeCardsMap || {}) as Record<string, NodeCard[]>;
  return map[nodeId] || [];
}

export function RoadmapNodeDrawer({
  open,
  nodeId,
  nodeLabel,
  nodeStatus,
  roadmapNodeType,
  contentRef,
  onClose,
}: {
  open: boolean;
  nodeId: string;
  nodeLabel: string;
  nodeStatus?: RoadmapStatus;
  roadmapNodeType?: string;
  contentRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<DrawerTab>('content');
  const supportsPractice = supportsRoadmapPracticeProblems(roadmapNodeType);
  const problems = useMemo(() => {
    if (!supportsPractice) return [];
    const cards = getNodeCards(nodeId);
    const list: Problem[] = [];
    cards.forEach((card) => {
      (card.problems || []).forEach((problem) => list.push(problem));
    });
    return list;
  }, [nodeId, open, supportsPractice]);

  useEffect(() => {
    if (!open) return undefined;
    setTab('content');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, nodeId, onClose]);

  if (!open) return null;

  const status = nodeStatus || 'planned';

  return ReactDOM.createPortal(
    <>
      <div className="roadmap-detail-backdrop" aria-hidden />
      <aside className="roadmap-detail-drawer" aria-label={nodeLabel}>
        <div className="roadmap-detail-drawer__header">
          <div className="roadmap-detail-drawer__tabs" role="tablist" aria-label={nodeLabel}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'content'}
              className={`roadmap-detail-drawer__tab${tab === 'content' ? ' is-active' : ''}`}
              onClick={() => setTab('content')}
            >
              {i18n('Roadmap drawer content')}
            </button>
            {supportsPractice ? (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'problems'}
                className={`roadmap-detail-drawer__tab${tab === 'problems' ? ' is-active' : ''}`}
                onClick={() => setTab('problems')}
              >
                {i18n('Roadmap drawer problems')}
                <span className="roadmap-detail-drawer__tab-count">{problems.length}</span>
              </button>
            ) : null}
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
          <div
            className={`roadmap-detail-drawer__panel${tab === 'content' ? ' is-active' : ''}`}
            role="tabpanel"
            hidden={tab !== 'content'}
          >
            <h1 className="roadmap-detail-drawer__title">{nodeLabel}</h1>
            <div ref={contentRef} className="roadmap-detail-drawer__markdown typo" />
          </div>

          {supportsPractice ? (
            <div
              className={`roadmap-detail-drawer__panel${tab === 'problems' ? ' is-active' : ''}`}
              role="tabpanel"
              hidden={tab !== 'problems'}
            >
              <h1 className="roadmap-detail-drawer__title">{nodeLabel}</h1>
              <RoadmapDrawerProblemList problems={problems} resetKey={`${nodeId}:${open}`} />
            </div>
          ) : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

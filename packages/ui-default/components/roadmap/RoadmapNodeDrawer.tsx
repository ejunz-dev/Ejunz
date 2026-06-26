import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n, request } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';
import { getRoadmapQueryContext, statusColor, statusLabel, type RoadmapStatus } from './shared';
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
  const [practiceBusy, setPracticeBusy] = useState(false);
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

  const startNodePractice = useCallback(async () => {
    const nid = String(nodeId || '').trim();
    if (!nid || practiceBusy || !supportsPractice) return;
    const { domainId, docId } = getRoadmapQueryContext();
    const roadmapDocNum = Number(docId);
    if (!Number.isFinite(roadmapDocNum) || roadmapDocNum <= 0) {
      Notification.error(i18n('Roadmap drawer start node practice invalid doc'));
      return;
    }
    const branch = String((window as any).UiContext?.roadmap?.currentBranch || 'main').trim() || 'main';
    setPracticeBusy(true);
    try {
      const res: any = await request.post(domainApiPath('/learn/lesson/start', domainId), {
        mode: 'node',
        nodeId: nid,
        baseDocId: roadmapDocNum,
        branch,
        learnSource: 'roadmap',
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || domainScopedPath('/learn/lesson', domainId);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const raw = typeof e?.message === 'string' ? e.message : String(e ?? '');
      const cleaned = raw.replace(/^[A-Za-z]+Error:\s*/i, '').trim();
      const msg = cleaned === 'No cards match session card filter'
        || cleaned === 'Learn requires cards with problems'
        ? i18n('Learn requires cards with problems')
        : cleaned === 'That node is not part of this branch.'
        || cleaned === 'That node is not part of this base branch'
        ? i18n('Outline editor start invalid node')
        : (cleaned || i18n('Outline learn start failed'));
      Notification.error(msg);
    } finally {
      setPracticeBusy(false);
    }
  }, [nodeId, practiceBusy, supportsPractice]);

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
      <button
        type="button"
        className="roadmap-detail-backdrop roadmap-detail-drawer-backdrop"
        onClick={onClose}
        aria-label={i18n('Close')}
      />
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
              <div className="roadmap-detail-drawer__practice-action">
                <button
                  type="button"
                  className="roadmap-detail-drawer__practice-btn"
                  disabled={practiceBusy || problems.length === 0}
                  onClick={() => { void startNodePractice(); }}
                >
                  {practiceBusy
                    ? i18n('Roadmap drawer start node practice busy')
                    : i18n('Roadmap drawer start node practice')}
                </button>
              </div>
              <RoadmapDrawerProblemList problems={problems} resetKey={`${nodeId}:${open}`} />
            </div>
          ) : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

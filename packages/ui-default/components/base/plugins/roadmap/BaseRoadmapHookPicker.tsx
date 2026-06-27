import React, { useMemo } from 'react';
import { i18n } from 'vj/utils';
import type { BaseNode } from 'vj/components/base/types';

/** Jump URL: open another roadmap node inside the same base document. */
export function buildBaseRoadmapHookUrl(
  targetRoadmapNodeId: string,
  basePath: string,
  docId?: string,
  branch?: string,
): string {
  const params = new URLSearchParams(window.location.search);
  params.set('nodeId', targetRoadmapNodeId);
  params.delete('cardId');
  const resolvedBranch = String(branch || (window as any).UiContext?.currentBranch || 'main').trim() || 'main';
  const path = docId
    ? `/${basePath}/${docId}/branch/${encodeURIComponent(resolvedBranch)}`
    : window.location.pathname;
  return `${path}?${params.toString()}`;
}

export function BaseRoadmapHookPicker({
  baseNodes,
  currentRoadmapNodeId,
  targetNodeId,
  branch,
  title,
  basePath,
  docId,
  onChange,
}: {
  baseNodes: BaseNode[];
  currentRoadmapNodeId?: string | null;
  /** hookRoadmapDocId stores the target base roadmap node id. */
  targetNodeId?: string | number;
  branch?: string;
  title?: string;
  basePath: string;
  docId?: string;
  onChange: (next: {
    hookRoadmapDocId: string;
    hookRoadmapBranch: string;
    hookRoadmapTitle: string;
    hookRoadmapUrl: string;
    label?: string;
  }) => void;
}) {
  const roadmaps = useMemo(
    () => baseNodes.filter((node) => {
      if (node.type !== 'roadmap') return false;
      if (currentRoadmapNodeId && node.id === currentRoadmapNodeId) return false;
      return true;
    }),
    [baseNodes, currentRoadmapNodeId],
  );

  const selectedId = targetNodeId != null && String(targetNodeId) !== '' ? String(targetNodeId) : '';
  const currentBranch = String(
    branch || (window as any).UiContext?.currentBranch || 'main',
  ).trim() || 'main';

  return (
    <div className="roadmap-hook-picker">
      <p className="roadmap-hook-picker__hint">{i18n('Roadmap hook node hint')}</p>
      <p className="roadmap-hook-picker__hint" style={{ marginTop: 0 }}>
        选择当前 Base 内的其他 Roadmap 节点作为跳转目标。
      </p>
      {title ? (
        <p className="roadmap-hook-picker__current">
          {i18n('Roadmap hook linked')}
          {': '}
          <strong>{title}</strong>
        </p>
      ) : null}
      <label className="roadmap-hook-picker__field">
        <span>{i18n('Roadmap hook target')}</span>
        <select
          value={selectedId}
          disabled={roadmaps.length === 0}
          onChange={(e) => {
            const nextId = e.currentTarget.value;
            if (!nextId) return;
            const item = roadmaps.find((row) => row.id === nextId);
            const nextTitle = String(item?.text || '').trim();
            onChange({
              hookRoadmapDocId: nextId,
              hookRoadmapBranch: currentBranch,
              hookRoadmapTitle: nextTitle,
              hookRoadmapUrl: buildBaseRoadmapHookUrl(nextId, basePath, docId, currentBranch),
              ...(nextTitle ? { label: nextTitle } : {}),
            });
          }}
        >
          <option value="">
            {roadmaps.length === 0
              ? '当前 Base 内没有其他 Roadmap'
              : i18n('Roadmap hook select placeholder')}
          </option>
          {roadmaps.map((row) => (
            <option key={row.id} value={row.id}>
              {row.text || row.id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

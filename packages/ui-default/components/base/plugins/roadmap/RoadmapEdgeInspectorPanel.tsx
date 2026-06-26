import React, { useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
import type { BaseEdge } from 'vj/components/base/types';
import type { RoadmapCanvasEdgeEditorApi } from '../types';
import {
  roadmapEdgeLineStyleFromStyle,
  type RoadmapEdgeLineStyle,
} from './shared';

export type RoadmapInspectorEdge = BaseEdge & {
  lineStyle?: string;
  label?: string;
  style?: Record<string, unknown>;
};

function installRoadmapInspectorCss() {
  const styleId = 'base-roadmap-inspector-css';
  if (document.getElementById(styleId)) return;
  const s = document.createElement('style');
  s.id = styleId;
  s.textContent = [
    '.roadmap-inspector--workspace{padding:12px 14px;overflow-y:auto;height:100%;box-sizing:border-box}',
    '.roadmap-inspector--workspace label{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;font-size:13px;font-weight:600}',
    '.roadmap-inspector--workspace input,.roadmap-inspector--workspace select{padding:6px 8px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;font-size:13px;font-weight:400}',
    '.roadmap-inspector--workspace p{margin:0 0 8px;font-size:12px;line-height:1.45}',
    '.roadmap-tool-button{padding:6px 12px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;background:transparent;font-size:13px;cursor:pointer}',
    '.roadmap-tool-button--danger{border-color:#c0392b;color:#c0392b}',
  ].join('');
  document.head.appendChild(s);
}

function edgeLineStyle(edge: RoadmapInspectorEdge): RoadmapEdgeLineStyle {
  if (edge.lineStyle) return edge.lineStyle as RoadmapEdgeLineStyle;
  const fromData = (edge as BaseEdge & { data?: { lineStyle?: RoadmapEdgeLineStyle } }).data?.lineStyle;
  if (fromData) return fromData;
  return roadmapEdgeLineStyleFromStyle(edge.style);
}

export function RoadmapEdgeInspectorPanel({
  edge,
  themeStyles,
  onUpdate,
  onDelete,
}: {
  edge: RoadmapInspectorEdge | null;
  themeStyles: Record<string, string>;
  onUpdate: (patch: { label?: string; lineStyle?: RoadmapEdgeLineStyle }) => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    installRoadmapInspectorCss();
  }, []);

  if (!edge) {
    return <div className="roadmap-inspector roadmap-inspector--workspace" />;
  }

  return (
    <div className="roadmap-inspector roadmap-inspector--workspace">
      <label style={{ color: themeStyles.textPrimary }}>
        {i18n('Roadmap edge label')}
        <input
          value={String(edge.label || '')}
          onChange={(e) => onUpdate({ label: e.currentTarget.value })}
        />
      </label>
      <label style={{ color: themeStyles.textPrimary }}>
        {i18n('Roadmap line style')}
        <select
          value={edgeLineStyle(edge)}
          onChange={(e) => onUpdate({ lineStyle: e.currentTarget.value as RoadmapEdgeLineStyle })}
        >
          <option value="solid">{i18n('Roadmap line solid')}</option>
          <option value="dashed">{i18n('Roadmap line dashed')}</option>
        </select>
      </label>
      <p style={{ color: themeStyles.textSecondary }}>{i18n('Roadmap edge source')}: {edge.source}</p>
      <p style={{ color: themeStyles.textSecondary }}>{i18n('Roadmap edge target')}: {edge.target}</p>
      <button type="button" className="roadmap-tool-button roadmap-tool-button--danger" onClick={onDelete}>
        {i18n('Roadmap delete edge')}
      </button>
    </div>
  );
}

export function ConnectedRoadmapEdgeInspectorPanel({
  edgeId,
  edgeSnapshot,
  edgeEditorApiRef,
  themeStyles,
}: {
  edgeId: string | null;
  edgeSnapshot: RoadmapInspectorEdge | null;
  edgeEditorApiRef: React.MutableRefObject<RoadmapCanvasEdgeEditorApi | null>;
  themeStyles: Record<string, string>;
}) {
  const [edge, setEdge] = useState<RoadmapInspectorEdge | null>(edgeSnapshot);

  useEffect(() => {
    if (!edgeId) {
      setEdge(null);
      return;
    }
    const sync = () => {
      const fromCanvas = edgeEditorApiRef.current?.getEdge(edgeId);
      setEdge(fromCanvas || edgeSnapshot);
    };
    sync();
    const frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [edgeId, edgeSnapshot, edgeEditorApiRef]);

  return (
    <RoadmapEdgeInspectorPanel
      edge={edge}
      themeStyles={themeStyles}
      onUpdate={(patch) => {
        if (!edgeId) return;
        edgeEditorApiRef.current?.updateEdge(edgeId, patch);
        const next = edgeEditorApiRef.current?.getEdge(edgeId);
        if (next) {
          setEdge(next);
          return;
        }
        setEdge((prev) => (
          prev
            ? {
              ...prev,
              ...patch,
              lineStyle: patch.lineStyle ?? edgeLineStyle(prev),
            }
            : prev
        ));
      }}
      onDelete={() => {
        if (!edgeId) return;
        edgeEditorApiRef.current?.deleteEdge(edgeId);
        setEdge(null);
      }}
    />
  );
}

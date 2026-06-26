import $ from 'jquery';
import React, { useCallback, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import type { BaseDoc, Card } from 'vj/components/base/types';
import { BaseDetailHeader } from 'vj/components/base/BaseDetailHeader';
import { BaseDetailEmbeddedRoadmapViewer } from 'vj/components/base/BaseDetailEmbeddedRoadmapViewer';
import { BaseDetailTreeDrawer } from 'vj/components/base/BaseDetailSidebar';
import { getRoadmapChildGraph, nodeDisplayLabel } from 'vj/components/base/detail_tree';

type BaseDetailContext = {
  domainId?: string;
  docId?: string;
  bid?: number;
  currentBranch?: string;
  title?: string;
  content?: string;
  nodes?: BaseDoc['nodes'];
  edges?: BaseDoc['edges'];
};

function getBaseDetailFromContext(): BaseDetailContext {
  const ctx = ((window as any).UiContext?.base || {}) as BaseDetailContext;
  return {
    domainId: ctx.domainId || (window as any).UiContext?.domainId || 'system',
    docId: String(ctx.docId || ''),
    bid: ctx.bid,
    currentBranch: ctx.currentBranch || 'main',
    title: ctx.title || '',
    content: ctx.content || '',
    nodes: ctx.nodes || [],
    edges: ctx.edges || [],
  };
}

function BaseDetailViewer() {
  const base = useMemo(() => getBaseDetailFromContext(), []);
  const nodeCardsMap = useMemo(
    () => (((window as any).UiContext?.nodeCardsMap || {}) as Record<string, Card[]>),
    [],
  );
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [selectedRoadmapNodeId, setSelectedRoadmapNodeId] = useState<string | null>(null);
  const [selectedCanvasNodeLabel, setSelectedCanvasNodeLabel] = useState<string | null>(null);
  const title = base.title?.trim() || String(i18n('Knowledge Base'));
  const branch = base.currentBranch || 'main';
  const nodes = base.nodes || [];
  const edges = base.edges || [];

  const selectedRoadmapNode = useMemo(
    () => nodes.find((node) => node.id === selectedRoadmapNodeId) || null,
    [nodes, selectedRoadmapNodeId],
  );
  const selectedRoadmapGraph = useMemo(() => {
    if (!selectedRoadmapNodeId) return { childNodes: [], childEdges: [] };
    return getRoadmapChildGraph(selectedRoadmapNodeId, nodes, edges);
  }, [edges, nodes, selectedRoadmapNodeId]);

  const handleSelectRoadmapNode = useCallback((nodeId: string) => {
    setSelectedRoadmapNodeId(nodeId);
    setSelectedCanvasNodeLabel(null);
    setTreeDrawerOpen(false);
  }, []);

  const headerTitle = useMemo(() => {
    if (selectedCanvasNodeLabel) return selectedCanvasNodeLabel;
    if (selectedRoadmapNode) return nodeDisplayLabel(selectedRoadmapNode);
    return title;
  }, [selectedCanvasNodeLabel, selectedRoadmapNode, title]);

  const headerDescription = useMemo(() => {
    if (selectedRoadmapNode) {
      if (selectedCanvasNodeLabel) return nodeDisplayLabel(selectedRoadmapNode);
      return title;
    }
    return base.content;
  }, [base.content, selectedCanvasNodeLabel, selectedRoadmapNode, title]);

  return (
    <div className="roadmap-detail-layout">
      <BaseDetailHeader
        title={headerTitle}
        description={headerDescription}
        domainId={base.domainId || 'system'}
        docId={base.docId || ''}
        branch={branch}
        treeDrawerOpen={treeDrawerOpen}
        onTreeDrawerOpen={() => setTreeDrawerOpen(true)}
      />
      <div className="roadmap-view">
        {selectedRoadmapNode ? (
          <div className="base-detail-roadmap-panel">
            <BaseDetailEmbeddedRoadmapViewer
              childNodes={selectedRoadmapGraph.childNodes}
              childEdges={selectedRoadmapGraph.childEdges}
              nodeCardsMap={nodeCardsMap}
              onSelectedNodeChange={(_nodeId, label) => setSelectedCanvasNodeLabel(label)}
            />
          </div>
        ) : (
          <main className="base-detail-main" aria-label={String(i18n('Content'))}>
            <div className="base-detail-main__placeholder">
              <p>{i18n('Base detail content placeholder')}</p>
            </div>
          </main>
        )}
      </div>
      <BaseDetailTreeDrawer
        open={treeDrawerOpen}
        nodes={nodes}
        edges={edges}
        nodeCardsMap={nodeCardsMap}
        selectedRoadmapNodeId={selectedRoadmapNodeId}
        onClose={() => setTreeDrawerOpen(false)}
        onSelectRoadmapNode={handleSelectRoadmapNode}
      />
    </div>
  );
}

const page = new NamedPage('base_detail', async () => {
  const $viewer = $('#base-detail-viewer');
  if (!$viewer.length) return;
  ReactDOM.render(<BaseDetailViewer />, $viewer[0]);
});

export default page;

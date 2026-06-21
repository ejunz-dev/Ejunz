import $ from 'jquery';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import {
  computeRoadmapAspectRatio,
  renderRoadmapSvg,
} from './roadmap_svg';
import {
  getRoadmapDocFromContext,
  getRoadmapQueryContext,
  normalizeRoadmapDoc,
  roadmapApiPath,
  RoadmapDoc,
} from './roadmap_shared';

function RoadmapSvgViewer({ initialDoc, mount }: { initialDoc: RoadmapDoc; mount: HTMLElement }) {
  const context = useMemo(() => getRoadmapQueryContext(mount), [mount]);
  const [doc, setDoc] = useState(() => normalizeRoadmapDoc(initialDoc));
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const aspectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (doc.nodes?.length || !context.docId) return;
    request.get(roadmapApiPath('/data', context.domainId), { docId: context.docId })
      .then((data: any) => setDoc(normalizeRoadmapDoc(data)))
      .catch((err) => Notification.error(err.message || '加载路线图失败'));
  }, [context.docId, context.domainId, doc.nodes?.length]);

  useEffect(() => {
    const wrap = svgWrapRef.current;
    const aspect = aspectRef.current;
    if (!wrap) return;

    wrap.replaceChildren();
    if (!doc.nodes?.length) {
      aspect?.style.removeProperty('--roadmap-aspect-ratio');
      return;
    }

    const svg = renderRoadmapSvg(doc.nodes, doc.edges || []);
    wrap.appendChild(svg);

    const ratio = computeRoadmapAspectRatio(svg);
    if (aspect && Number.isFinite(ratio) && ratio > 0) {
      aspect.style.setProperty('--roadmap-aspect-ratio', String(ratio));
    }
  }, [doc.edges, doc.nodes]);

  if (!doc.nodes?.length) {
    return (
      <div className="roadmap-view__empty">
        <p>路线图还没有内容。</p>
      </div>
    );
  }

  return (
    <div className="roadmap-view">
      <div ref={aspectRef} className="roadmap-view__aspect">
        <div
          ref={svgWrapRef}
          id="roadmap-svg-wrap"
          className="roadmap-view__svg"
          data-renderer="svg"
        />
      </div>
    </div>
  );
}

const page = new NamedPage('roadmap_detail', async () => {
  const $viewer = $('#roadmap-viewer');
  if (!$viewer.length) return;
  const initialDoc = normalizeRoadmapDoc(getRoadmapDocFromContext());
  ReactDOM.render(<RoadmapSvgViewer initialDoc={initialDoc} mount={$viewer[0]} />, $viewer[0]);
});

export default page;

import React, { useEffect, useState } from 'react';
import { request, i18n } from 'vj/utils';
import { roadmapApiPath } from './shared';

interface RoadmapListItem {
  docId: string | number;
  title?: string;
}

export function RoadmapHookPicker({
  domainId,
  docId,
  branch,
  title,
  onChange,
}: {
  domainId: string;
  docId?: string | number;
  branch?: string;
  title?: string;
  onChange: (next: { docId: string; branch: string; title: string }) => void;
}) {
  const [roadmaps, setRoadmaps] = useState<RoadmapListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    request.get(roadmapApiPath('/list', domainId), { format: 'json' })
      .then((data: { roadmaps?: RoadmapListItem[] }) => {
        if (cancelled) return;
        setRoadmaps(Array.isArray(data?.roadmaps) ? data.roadmaps : []);
      })
      .catch(() => {
        if (!cancelled) setRoadmaps([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [domainId]);

  const selectedId = docId != null && String(docId) !== '' ? String(docId) : '';
  const selectedBranch = String(branch || 'main');

  return (
    <div className="roadmap-hook-picker">
      <p className="roadmap-hook-picker__hint">{i18n('Roadmap hook node hint')}</p>
      {title ? (
        <p className="roadmap-hook-picker__current">
          {i18n('Roadmap hook linked')}: <strong>{title}</strong>
        </p>
      ) : null}
      <label className="roadmap-hook-picker__field">
        <span>{i18n('Roadmap hook target')}</span>
        <select
          value={selectedId}
          disabled={loading}
          onChange={(e) => {
            const nextId = e.currentTarget.value;
            const item = roadmaps.find((row) => String(row.docId) === nextId);
            onChange({
              docId: nextId,
              branch: 'main',
              title: String(item?.title || '').trim(),
            });
          }}
        >
          <option value="">{loading ? i18n('Loading...') : i18n('Roadmap hook select placeholder')}</option>
          {roadmaps.map((row) => (
            <option key={String(row.docId)} value={String(row.docId)}>
              {row.title || String(row.docId)}
            </option>
          ))}
        </select>
      </label>
      <label className="roadmap-hook-picker__field">
        <span>{i18n('Roadmap branch')}</span>
        <input
          value={selectedBranch}
          onChange={(e) => onChange({
            docId: selectedId,
            branch: e.currentTarget.value.trim() || 'main',
            title: title || '',
          })}
          placeholder="main"
        />
      </label>
    </div>
  );
}

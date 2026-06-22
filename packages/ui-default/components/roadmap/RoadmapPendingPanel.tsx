import React from 'react';
import { i18n } from 'vj/utils';
import type { EditorThemeStyles } from 'vj/components/editor_workspace/theme';
import {
  ROADMAP_PENDING_COLORS,
  type RoadmapPendingChanges,
  type RoadmapPendingItem,
} from './pending_changes';

function PendingSection({
  title,
  items,
  themeStyles,
  accentColor,
  onSelect,
}: {
  title: string;
  items: RoadmapPendingItem[];
  themeStyles: EditorThemeStyles;
  accentColor?: string;
  onSelect?: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div>
      <div style={{ fontWeight: 500, marginBottom: 4, color: accentColor || themeStyles.textPrimary }}>
        {title}
        {' '}
        (
        {items.length}
        )
      </div>
      <div style={{ paddingLeft: 12, fontSize: 10, color: themeStyles.textSecondary }}>
        {items.slice(0, 8).map((item) => (
          <div
            key={item.id}
            style={{
              marginBottom: 2,
              cursor: onSelect ? 'pointer' : 'default',
              color: onSelect ? themeStyles.textPrimary : themeStyles.textSecondary,
              borderLeft: accentColor ? `3px solid ${accentColor}` : undefined,
              paddingLeft: accentColor ? 6 : 0,
            }}
            onClick={onSelect ? () => onSelect(item.id) : undefined}
            onKeyDown={onSelect ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item.id);
              }
            } : undefined}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
          >
            •
            {' '}
            {item.label}
          </div>
        ))}
        {items.length > 8 ? (
          <div style={{ color: themeStyles.textTertiary, fontStyle: 'italic' }}>
            … +
            {items.length - 8}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RoadmapPendingPanel({
  pending,
  pendingProblemCards = [],
  themeStyles,
  onSelectNode,
  onSelectEdge,
  onSelectProblemNode,
}: {
  pending: RoadmapPendingChanges;
  pendingProblemCards?: RoadmapPendingItem[];
  themeStyles: EditorThemeStyles;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onSelectProblemNode?: (nodeId: string) => void;
}) {
  const empty = !pending.createdNodes.length
    && !pending.deletedNodes.length
    && !pending.updatedNodes.length
    && !pending.createdEdges.length
    && !pending.deletedEdges.length
    && !pending.updatedEdges.length
    && !pending.viewportChanged
    && !pendingProblemCards.length;

  const color = (kind: 'create' | 'update' | 'delete') => ROADMAP_PENDING_COLORS[kind];

  return (
    <div style={{ padding: 8, overflowY: 'auto', flex: 1, minHeight: 0, height: '100%' }}>
      <div style={{
        fontSize: 11,
        color: themeStyles.textSecondary,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '0 8px',
      }}
      >
        {empty ? (
          <div style={{
            color: themeStyles.textTertiary,
            fontStyle: 'italic',
            textAlign: 'center',
            padding: '8px 0',
          }}
          >
            {i18n('Roadmap pending empty')}
          </div>
        ) : (
          <>
            <PendingSection
              title={i18n('Roadmap pending created nodes')}
              items={pending.createdNodes}
              themeStyles={themeStyles}
              accentColor={color('create')}
              onSelect={onSelectNode}
            />
            <PendingSection
              title={i18n('Roadmap pending updated nodes')}
              items={pending.updatedNodes}
              themeStyles={themeStyles}
              accentColor={color('update')}
              onSelect={onSelectNode}
            />
            <PendingSection
              title={i18n('Roadmap pending deleted nodes')}
              items={pending.deletedNodes}
              themeStyles={themeStyles}
              accentColor={color('delete')}
            />
            <PendingSection
              title={i18n('Roadmap pending created edges')}
              items={pending.createdEdges}
              themeStyles={themeStyles}
              accentColor={color('create')}
              onSelect={onSelectEdge}
            />
            <PendingSection
              title={i18n('Roadmap pending updated edges')}
              items={pending.updatedEdges}
              themeStyles={themeStyles}
              accentColor={color('update')}
              onSelect={onSelectEdge}
            />
            <PendingSection
              title={i18n('Roadmap pending deleted edges')}
              items={pending.deletedEdges}
              themeStyles={themeStyles}
              accentColor={color('delete')}
            />
            {pending.viewportChanged ? (
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4, color: color('update') }}>
                  {i18n('Roadmap pending viewport changed')}
                </div>
              </div>
            ) : null}
            <PendingSection
              title={i18n('Roadmap pending updated problems')}
              items={pendingProblemCards}
              themeStyles={themeStyles}
              accentColor={color('update')}
              onSelect={onSelectProblemNode}
            />
          </>
        )}
      </div>
    </div>
  );
}

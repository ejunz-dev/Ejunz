import { Fragment, useMemo } from 'react';
import { useUserContext } from '../../context/page-data';
import { i18n } from '../../i18n';
import {
  cardDisplayLabel,
  getMixedNodeChildren,
  nodeDisplayLabel,
} from './tree';
import { cardMatchesFilters, cardMatchesSearch, nodeMatchesFilter, nodeMatchesSearch, type BaseDetailFilter } from './detail-filter';
import { defaultBaseDetailDisplaySettings, type BaseDetailDisplaySettings } from './display-settings';
import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode, BaseDetailProblem } from './types';

interface Props {
  rootNodeIds: string[];
  nodes: BaseDetailNode[];
  edges: BaseDetailEdge[];
  nodeCardsMap: Record<string, BaseDetailCard[]>;
  expandedNodes: Set<string>;
  onToggle: (nodeId: string) => void;
  selectedNodeId: string | null;
  selectedCardId: string | null;
  selectedProblemId?: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectCard: (card: BaseDetailCard) => void;
  onSelectProblem?: (card: BaseDetailCard, pid: string) => void;
  filter?: string;
  filters?: BaseDetailFilter;
  displaySettings?: BaseDetailDisplaySettings;
  highlightSelectedNode?: boolean;
  emptyMessage?: string;
}

function matches(card: BaseDetailCard, query: string): boolean {
  return cardMatchesSearch(card, query);
}

function problemLabel(problem: BaseDetailProblem, index: number): string {
  const title = String(problem.title || problem.stem || problem.content || '')
    .replace(/<[^>]+>/g, '').trim();
  return title.slice(0, 72) || `${i18n('Problem')} ${index + 1}`;
}

function formatAbsoluteDate(raw?: string | Date | null): string {
  if (!raw) return '';
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatRelativeDate(raw?: string | Date | null, locale = 'zh'): string {
  if (!raw) return '';
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  // Match moment's fromNow() unit thresholds.
  let unit: Intl.RelativeTimeFormatUnit;
  let value: number;
  if (absMs < 45_000) { unit = 'second'; value = Math.round(diffMs / 1000); }
  else if (absMs < 90_000) { unit = 'minute'; value = Math.round(diffMs / minute); }
  else if (absMs < 45 * minute) { unit = 'minute'; value = Math.round(diffMs / minute); }
  else if (absMs < 90 * minute) { unit = 'hour'; value = Math.round(diffMs / hour); }
  else if (absMs < 22 * hour) { unit = 'hour'; value = Math.round(diffMs / hour); }
  else if (absMs < 36 * hour) { unit = 'day'; value = Math.round(diffMs / day); }
  else if (absMs < 25 * day) { unit = 'day'; value = Math.round(diffMs / day); }
  else if (absMs < 45 * day) { unit = 'month'; value = Math.round(diffMs / (30 * day)); }
  else if (absMs < 345 * day) { unit = 'month'; value = Math.round(diffMs / (30 * day)); }
  else if (absMs < 545 * day) { unit = 'year'; value = Math.round(diffMs / (365 * day)); }
  else { unit = 'year'; value = Math.round(diffMs / (365 * day)); }
  return rtf.format(value, unit);
}

function TimestampMeta({ createdAt, updateAt }: { createdAt?: string | Date | null; updateAt?: string | Date | null }) {
  const user = useUserContext();
  const locale = String((user as any)?.viewLang || 'zh');
  const created = formatAbsoluteDate(createdAt);
  const updated = formatRelativeDate(updateAt, locale);
  if (!created && !updated) return null;
  const parts: string[] = [];
  if (created) parts.push(i18n('Created at: {0}', created));
  if (updated) parts.push(i18n('Updated at: {0}', updated));
  return <span className="bd-tree__meta">{parts.join(' · ')}</span>;
}

function TagList({ tags, problem = false }: { tags?: string[]; problem?: boolean }) {
  if (!tags?.length) return null;
  return (
    <span className={`bd-tree__tags${problem ? ' bd-tree__tags--problem' : ''}`}>
      {tags.map((tag) => <span className="bd-tree__tag" key={tag}>{tag}</span>)}
    </span>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={expanded ? 'bd-tree__chevron is-expanded' : 'bd-tree__chevron'} />
    </svg>
  );
}

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      {expanded ? <path fillRule="evenodd" clipRule="evenodd" d="M1.5 3l.5-.5h5.67l.5.5L9 5h4.5l.5.5v1.19l-.02.01 1.99 5.52-.47.78H2l-.5-.5V3zm5.5 2L6 4.5H2V5h5z" /> : <path fillRule="evenodd" clipRule="evenodd" d="M7.17 3H1.5l-.5.5V5h1V4h5.33l.5.5V7H14L13 4.91l-.44-.12-.5-1.13L11.98 3H7.17zM14 8H2v4.5l.5.5h11l.5-.5V8zm-1 0v4H3V8h10z" />}
    </svg>
  );
}

function RoadmapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 7.2l4-2.4M6 8.8l4 2.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CardIcon({ card }: { card: BaseDetailCard }) {
  const type = `${card.fileType || card.cardType || ''}`.toLowerCase();
  const color = type === 'pdf' ? '#d93025' : type === 'image' ? '#1a73e8' : type === 'video' ? '#e8710a' : type === 'audio' ? '#7c33d3' : type === 'code' ? '#0d652d' : '#5f6b7a';
  const path = type === 'pdf'
    ? 'M13.85 4.44l-3.28-3.3-.35-.14H2.5l-.5.5V7h1V2h6v3.5l.5.5H13v1h1V4.8zM10 5V2l3 3h-3zM2.5 8l-.5.5v6l.5.5h11l.5-.5v-6l-.5-.5h-11zM13 13v1H3V9h10v4z'
    : type === 'image'
      ? 'M14.25 4.74L11 6.62V4.5l-.5-.5h-9l-.5.5v7l.5.5h9l.5-.5v-2l3.25 1.87.75-.47V5.18zM10 11H2V5h8v6zm4-1l-3-1.7v-.52L14 6v4z'
      : type === 'video' || type === 'audio'
        ? 'M13.47 2L5.47 2.5 5 3v7.5A2.5 2.5 0 1 0 6 12.5V6.47l7-.44V7h1V2.5zM3.5 11A1.5 1.5 0 1 1 2 12.5 1.5 1.5 0 0 1 3.5 11z'
        : type === 'code'
          ? 'M13.85 4.44L10.57 1.14 10.22 1H2.5l-.5.5v13l.5.5h11l.5-.5V4.8zM13 14H3V2h6v3.5l.5.5H13zM6.85 7.85L5.2 9.5l1.65 1.65-.7.7-2-2v-.7l2-2zm2.3 0l.7-.7 2 2v.7l-2 2-.7-.7 1.65-1.65z'
          : 'M1.5 2h13l.5.5v10l-.5.5h-13l-.5-.5v-10zM2 3v9h12V3H2zm2 2h8v1H4zm0 2h6v1H4zm0 2h4v1H4z';
  return <span className="bd-tree__card-icon" aria-hidden><svg width="16" height="16" viewBox="0 0 16 16" fill={color}><path d={path} /></svg></span>;
}

function TreeBranch({
  nodeId, level, nodes, edges, nodeCardsMap, expandedNodes, onToggle,
  selectedNodeId, selectedCardId, selectedProblemId, onSelectNode, onSelectCard, onSelectProblem, query, filters, displaySettings, highlightSelectedNode,
}: Omit<Props, 'rootNodeIds' | 'emptyMessage' | 'filter' | 'filters' | 'displaySettings' | 'highlightSelectedNode'> & { nodeId: string; level: number; query: string; filters: BaseDetailFilter; displaySettings: BaseDetailDisplaySettings; highlightSelectedNode: boolean }) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  const children = getMixedNodeChildren(nodeId, nodes, edges, nodeCardsMap).filter((child) => (
    child.kind === 'node'
      ? subtreeMatches(child.node.id, nodes, edges, nodeCardsMap, query, filters)
      : cardMatchesFilters(child.card, filters) && (!query || matches(child.card, query) || nodeMatchesSearch(node, query))
  ));
  const expanded = expandedNodes.has(nodeId) || !!query || Object.values(filters).some(Boolean);
  const hasChildren = children.length > 0;

  return (
    <div className="bd-tree__branch">
      <div className={`bd-tree__row bd-tree__row--node${highlightSelectedNode && selectedNodeId === nodeId ? ' is-selected' : ''}${node.type === 'roadmap' ? ' is-roadmap' : ''}`} style={{ paddingLeft: `${level * 1.1}rem` }}>
        {hasChildren ? (
          <button type="button" className="bd-tree__toggle" onClick={() => onToggle(nodeId)} aria-expanded={expanded} aria-label={expanded ? i18n('Collapse') : i18n('Expand')}>
            <ChevronIcon expanded={expanded} />
          </button>
        ) : <span className="bd-tree__toggle-spacer" />}
        <button type="button" className="bd-tree__main" onClick={() => onSelectNode(nodeId)}>
          <span className="bd-tree__node-icon">{node.type === 'roadmap' ? <RoadmapIcon /> : <FolderIcon expanded={expanded} />}</span>
          <span className="bd-tree__label" title={nodeDisplayLabel(node)}>{nodeDisplayLabel(node)}</span>
          {displaySettings.showNodeNumber && node.order != null ? <span className="bd-tree__meta">#{node.order + 1}</span> : null}
          {displaySettings.showNodeCardTimestamps ? <TimestampMeta createdAt={node.createdAt} updateAt={node.updateAt} /> : null}
        </button>
      </div>
      {expanded && hasChildren ? (
        <div className="bd-tree__children">
          {children.map((child) => child.kind === 'node' ? (
            <TreeBranch key={child.node.id} nodeId={child.node.id} level={level + 1} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={onToggle} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} selectedProblemId={selectedProblemId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} onSelectProblem={onSelectProblem} query={query} filters={filters} displaySettings={displaySettings} highlightSelectedNode={highlightSelectedNode} />
          ) : (
            <Fragment key={child.card.docId}>
              <div className={`bd-tree__row bd-tree__row--card${selectedCardId === child.card.docId ? ' is-selected' : ''}`} style={{ paddingLeft: `${(level + 1) * 1.1}rem` }}>
                <span className="bd-tree__toggle-spacer" />
                <button type="button" className="bd-tree__main" onClick={() => onSelectCard(child.card)}>
                  <CardIcon card={child.card} />
                  <span className="bd-tree__label" title={cardDisplayLabel(child.card)}>{cardDisplayLabel(child.card)}</span>
                  {displaySettings.showNodeCardTimestamps ? <TimestampMeta createdAt={child.card.createdAt} updateAt={child.card.updateAt} /> : null}
                  {displaySettings.showProblemCount && child.card.problems?.length ? <span className="bd-tree__problem-count">{child.card.problems.length}</span> : null}
                  {displaySettings.showCardTags ? <TagList tags={child.card.tags} /> : null}
                </button>
              </div>
              {displaySettings.showProblemTree ? child.card.problems?.map((problem, index) => {
                const pid = String(problem.pid || `problem-${index}`);
                return (
                  <div key={pid} className="bd-tree__row bd-tree__row--problem" style={{ paddingLeft: `${(level + 2) * 1.1}rem` }}>
                    <span className="bd-tree__toggle-spacer" />
                    <button type="button" className="bd-tree__main" onClick={() => { onSelectCard(child.card); onSelectProblem?.(child.card, pid); }}>
                      <span className="bd-tree__label">{problemLabel(problem, index)}</span>{displaySettings.showProblemTags ? <TagList tags={problem.tags} problem /> : null}
                    </button>
                  </div>
                );
              }) : null}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function hasCardFilters(filters: BaseDetailFilter): boolean {
  return !!(filters.filterCard.trim() || filters.filterProblem.trim() || filters.filterCardTag.trim() || filters.filterProblemTag.trim());
}

function cardIsVisible(card: BaseDetailCard, node: BaseDetailNode, query: string, filters: BaseDetailFilter): boolean {
  if (!nodeMatchesFilter(node, filters) || !cardMatchesFilters(card, filters)) return false;
  return !query || nodeMatchesSearch(node, query) || matches(card, query);
}

function subtreeMatches(nodeId: string, nodes: BaseDetailNode[], edges: BaseDetailEdge[], cards: Record<string, BaseDetailCard[]>, query: string, filters: BaseDetailFilter): boolean {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  const nodeMatches = nodeMatchesFilter(node, filters) && (!query || nodeMatchesSearch(node, query));
  const ownCards = getMixedNodeChildren(nodeId, nodes, edges, cards).filter((child): child is { kind: 'card'; card: BaseDetailCard; order: number } => child.kind === 'card');
  if (nodeMatches && (!hasCardFilters(filters) || ownCards.some((child) => cardMatchesFilters(child.card, filters)))) return true;
  return getMixedNodeChildren(nodeId, nodes, edges, cards).some((child) => child.kind === 'node'
    ? subtreeMatches(child.node.id, nodes, edges, cards, query, filters)
    : cardIsVisible(child.card, node, query, filters));
}

export function BaseDetailTree({ rootNodeIds, nodes, edges, nodeCardsMap, expandedNodes, onToggle, selectedNodeId, selectedCardId, selectedProblemId, onSelectNode, onSelectCard, onSelectProblem, filter = '', filters = { filterNode: '', filterCard: '', filterProblem: '', filterCardTag: '', filterProblemTag: '' }, displaySettings = defaultBaseDetailDisplaySettings(), highlightSelectedNode = true, emptyMessage = i18n('Base detail tree empty') }: Props) {
  const query = filter.trim().toLowerCase();
  const active = !!query || Object.values(filters).some(Boolean);
  const visibleRoots = useMemo(() => rootNodeIds.filter((id) => !active || subtreeMatches(id, nodes, edges, nodeCardsMap, query, filters)), [active, edges, filters, nodeCardsMap, nodes, query, rootNodeIds]);
  if (!visibleRoots.length) return <p className="bd-empty">{active ? i18n('Roadmap detail search no results') : emptyMessage}</p>;
  return <div className="bd-tree">{visibleRoots.map((id) => <TreeBranch key={id} nodeId={id} level={0} nodes={nodes} edges={edges} nodeCardsMap={nodeCardsMap} expandedNodes={expandedNodes} onToggle={onToggle} selectedNodeId={selectedNodeId} selectedCardId={selectedCardId} selectedProblemId={selectedProblemId} onSelectNode={onSelectNode} onSelectCard={onSelectCard} onSelectProblem={onSelectProblem} query={query} filters={filters} displaySettings={displaySettings} highlightSelectedNode={highlightSelectedNode} />)}</div>;
}

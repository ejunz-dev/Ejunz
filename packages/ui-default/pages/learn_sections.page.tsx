import React, { useState, useCallback, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

interface CardProblem {
  pid: string;
  stem: string;
  options?: string[];
  answer?: number;
}

interface LearnCard {
  cardId: string;
  title: string;
  order?: number;
  problemCount?: number;
  problems?: CardProblem[];
}

interface LearnDAGNode {
  _id: string;
  title: string;
  requireNids: string[];
  cards: LearnCard[];
  order?: number;
}

interface LearnSectionsTreeProps {
  sections: LearnDAGNode[];
  dag: LearnDAGNode[];
  domainId: string;
  currentSectionId: string | null;
  currentLearnSectionIndex: number | null;
}

function buildNodeMap(sections: LearnDAGNode[], dag: LearnDAGNode[]) {
  const nodeMap = new Map<string, LearnDAGNode>();
  sections.forEach(n => nodeMap.set(n._id, n));
  dag.forEach(n => nodeMap.set(n._id, n));
  return nodeMap;
}

function getChildren(nodeId: string, sections: LearnDAGNode[], dag: LearnDAGNode[]) {
  const children: LearnDAGNode[] = [];
  dag.forEach(n => {
    const parentId = n.requireNids?.[n.requireNids.length - 1];
    if (parentId === nodeId) children.push(n);
  });
  return children.sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 获取单张卡片的题目数：优先 problemCount，其次 problems.length，无数据时按 1 张卡片计
function getCardProblemCount(card: LearnCard): number {
  if (card.problemCount !== undefined && card.problemCount > 0) return card.problemCount;
  if (card.problems && card.problems.length > 0) return card.problems.length;
  return 1; // 有卡片但无题目数据时，按 1 计（避免不显示）
}

// 递归计算节点及其所有子节点下的题目总数（包括子节点中的题目）
function getTotalProblemCount(nodeId: string, sections: LearnDAGNode[], dag: LearnDAGNode[]): number {
  const node = sections.find(n => n._id === nodeId) || dag.find(n => n._id === nodeId);
  if (!node) return 0;

  const directCount = (node.cards || []).reduce((sum, c) => sum + getCardProblemCount(c), 0);
  const children = getChildren(nodeId, sections, dag);
  const childCount = children.reduce((sum, child) => sum + getTotalProblemCount(child._id, sections, dag), 0);
  return directCount + childCount;
}

function getTheme(): 'light' | 'dark' {
  try {
    if ((window as any).Ejunz?.utils?.getTheme) {
      return (window as any).Ejunz.utils.getTheme();
    }
    if ((window as any).UserContext?.theme) {
      return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
    }
  } catch (e) {
    console.warn('Failed to get theme:', e);
  }
  return 'light';
}

function LearnSectionsTree({ sections, dag, domainId, currentSectionId, currentLearnSectionIndex }: LearnSectionsTreeProps) {
  const [selectedSectionIndex, setSelectedSectionIndex] = useState<number>(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(getTheme);

  useEffect(() => {
    if (sections.length === 0) return;
    const defaultIndex = typeof currentLearnSectionIndex === 'number' && currentLearnSectionIndex >= 0 && currentLearnSectionIndex < sections.length
      ? currentLearnSectionIndex
      : currentSectionId
        ? Math.max(0, sections.findIndex(s => s._id === currentSectionId))
        : 0;
    setSelectedSectionIndex(defaultIndex >= 0 ? defaultIndex : 0);
  }, [sections, currentSectionId, currentLearnSectionIndex]);

  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) setTheme(newTheme);
    };
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme]);

  const themeStyles = useMemo(() => ({
    bgPrimary: theme === 'dark' ? '#1e1e1e' : '#fff',
    bgSecondary: theme === 'dark' ? '#2d2d2d' : '#f6f8fa',
    bgSidebar: theme === 'dark' ? '#252526' : '#f3f4f6',
    bgHover: theme === 'dark' ? '#404040' : '#e8eaed',
    textPrimary: theme === 'dark' ? '#fff' : '#24292e',
    textSecondary: theme === 'dark' ? '#bdbdbd' : '#586069',
    border: theme === 'dark' ? '#404040' : '#e1e4e8',
    accent: theme === 'dark' ? '#64b5f6' : '#1976d2',
    cardBg: theme === 'dark' ? '#1e3a5f' : '#f0f7ff',
    cardBorder: theme === 'dark' ? '#2d4a6f' : '#e3f2fd',
    // 不同 level 的 node 气泡颜色
    nodeBubbleColors: [
      theme === 'dark' ? '#1976d2' : '#1976d2',   // level 0: 蓝
      theme === 'dark' ? '#2e7d32' : '#2e7d32',   // level 1: 绿
      theme === 'dark' ? '#7b1fa2' : '#7b1fa2',   // level 2: 紫
      theme === 'dark' ? '#ed6c02' : '#ed6c02',   // level 3: 橙
    ] as const,
  }), [theme]);

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set());

  // 默认全部展开：当 sections/dag 加载后，将所有节点加入展开集合
  useEffect(() => {
    if (sections.length === 0 && dag.length === 0) return;
    setExpandedNodes(prev => {
      const next = new Set(prev);
      sections.forEach(s => next.add(s._id));
      dag.forEach(n => next.add(n._id));
      return next;
    });
  }, [sections, dag]);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [singleCardModal, setSingleCardModal] = useState<{ cardId: string; title: string } | null>(null);
  const [singleNodeModal, setSingleNodeModal] = useState<{ nodeId: string; title: string } | null>(null);

  const MOBILE_BREAKPOINT = 768;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const nodeMap = useMemo(() => buildNodeMap(sections, dag), [sections, dag]);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const getLearnUrl = useCallback((sectionId: string) => {
    return `/d/${domainId}/learn?sectionId=${sectionId}`;
  }, [domainId]);

  const getLessonUrl = useCallback((cardId: string) => {
    return `/d/${domainId}/learn/lesson?cardId=${cardId}`;
  }, [domainId]);

  const getNodeLessonUrl = useCallback((nodeId: string) => {
    return `/d/${domainId}/learn/lesson?nodeId=${encodeURIComponent(nodeId)}`;
  }, [domainId]);

  const openSingleNodeModal = useCallback((node: LearnDAGNode) => {
    setSingleNodeModal({ nodeId: node._id, title: node.title || i18n('Unnamed Node') });
  }, []);

  const confirmSingleNodeMode = useCallback(() => {
    if (!singleNodeModal) return;
    const url = getNodeLessonUrl(singleNodeModal.nodeId);
    window.open(url, '_blank', 'noopener,noreferrer');
    setSingleNodeModal(null);
  }, [singleNodeModal, getNodeLessonUrl]);

  const openSingleCardModal = useCallback((card: LearnCard) => {
    setSingleCardModal({ cardId: String(card.cardId), title: card.title || i18n('Unnamed Card') });
  }, []);

  const confirmSingleCardMode = useCallback(() => {
    if (!singleCardModal) return;
    const url = getLessonUrl(singleCardModal.cardId);
    window.open(url, '_blank', 'noopener,noreferrer');
    setSingleCardModal(null);
  }, [singleCardModal, getLessonUrl]);

  const toggleCardExpand = useCallback((cardId: string) => {
    const id = String(cardId);
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderNode = useCallback((node: LearnDAGNode, level: number, isRootCurrentSection = false) => {
    const children = getChildren(node._id, sections, dag);
    const cards = node.cards || [];
    const hasContent = children.length > 0 || cards.length > 0;
    const expanded = expandedNodes.has(node._id);
    const isCurrentSection = isRootCurrentSection;
    const totalProblemCount = getTotalProblemCount(node._id, sections, dag);

    const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: LearnDAGNode | LearnCard }> = [
      ...children.map(n => ({ type: 'node' as const, id: n._id, order: n.order || 0, data: n })),
      ...cards.map(c => ({ type: 'card' as const, id: c.cardId, order: (c.order as number) || 0, data: c })),
    ];
    allChildren.sort((a, b) => a.order - b.order);

    return (
      <div key={node._id} style={{ position: 'relative' }}>
        <div style={{ marginLeft: `${level * 24}px`, position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 0',
                cursor: 'pointer',
                position: 'relative',
                zIndex: 1,
                width: '100%',
              }}
              onClick={(e) => { e.stopPropagation(); openSingleNodeModal(node); }}
              onMouseEnter={(e) => {
                if (!isCurrentSection) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
              }}
              onMouseLeave={(e) => {
                if (!isCurrentSection) e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {hasContent ? (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleExpand(node._id); }}
                  style={{
                    width: '18px',
                    height: '18px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: '4px',
                    padding: 0,
                    flexShrink: 0,
                    color: themeStyles.textSecondary,
                  }}
                  title={expanded ? (i18n('Collapse') || '折叠') : (i18n('Expand') || '展开')}
                >
                  <span style={{ fontSize: '10px', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s ease' }}>▼</span>
                </button>
              ) : (
                <div style={{ width: '22px', marginRight: '0px', flexShrink: 0 }} />
              )}
              <span style={{ marginRight: '8px', color: themeStyles.textSecondary, fontSize: '12px', flexShrink: 0 }}>•</span>
              <div
                style={{
                  flex: 1,
                  color: isCurrentSection ? themeStyles.accent : themeStyles.textPrimary,
                  fontSize: '14px',
                  fontWeight: isCurrentSection ? '600' : 'normal',
                  lineHeight: '1.5',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                {node.title}
                {isCurrentSection && (
                  <span style={{ color: '#4CAF50', fontSize: '0.8em' }}>
                    ({i18n('Current Progress')})
                  </span>
                )}
                {totalProblemCount > 0 && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: '28px',
                      height: '22px',
                      padding: '0 10px',
                      fontSize: '13px',
                      fontWeight: '700',
                      color: '#fff',
                      backgroundColor: themeStyles.nodeBubbleColors[Math.min(level, themeStyles.nodeBubbleColors.length - 1)],
                      borderRadius: '11px',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.25)',
                      marginLeft: '8px',
                    }}
                    title={i18n('Contains {0} problems').format(totalProblemCount)}
                  >
                    {totalProblemCount}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {expanded && allChildren.length > 0 && (
          <div style={{ position: 'relative', marginLeft: `${level * 24}px` }}>
            <div style={{ position: 'absolute', left: '8px', top: '0px', bottom: '0px', width: '1px', backgroundColor: themeStyles.border, zIndex: 0 }} />
            <div>
              {allChildren.map((item) => {
                if (item.type === 'card') {
                  const card = item.data as LearnCard;
                  const cardIdStr = String(card.cardId);
                  const problemCount = card.problemCount ?? (card.problems?.length ?? 0);
                  const problems = card.problems ?? [];
                  const isCardExpanded = expandedCards.has(cardIdStr);
                  return (
                    <div key={`card-${card.cardId}`} style={{ marginLeft: '24px', marginTop: '4px', marginBottom: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <div
                          onClick={(e) => { e.stopPropagation(); openSingleCardModal(card); }}
                          style={{
                            display: 'inline-block',
                            padding: '4px 8px',
                            fontSize: '12px',
                            color: themeStyles.accent,
                            textDecoration: 'none',
                            borderRadius: '4px',
                            backgroundColor: themeStyles.cardBg,
                            border: `1px solid ${themeStyles.cardBorder}`,
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            maxWidth: 'fit-content',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = '0.85';
                            e.currentTarget.style.textDecoration = 'underline';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = '1';
                            e.currentTarget.style.textDecoration = 'none';
                          }}
                          title={card.title}
                        >
                          {card.title || i18n('Unnamed Card')}
                        </div>
                        {problemCount > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleCardExpand(cardIdStr);
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: '24px',
                              height: '20px',
                              padding: '0 8px',
                              fontSize: '12px',
                              fontWeight: '600',
                              color: themeStyles.accent,
                              backgroundColor: 'transparent',
                              border: `2px solid ${themeStyles.accent}`,
                              borderRadius: '4px',
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              position: 'relative',
                              zIndex: 1,
                              outline: 'none',
                              fontFamily: 'inherit',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = themeStyles.cardBg;
                              e.currentTarget.style.transform = 'scale(1.05)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = 'transparent';
                              e.currentTarget.style.transform = 'scale(1)';
                            }}
                            title={i18n('Click to expand questions')}
                          >
                            {problemCount}
                          </button>
                        )}
                      </div>
                      {isCardExpanded && (
                        <div style={{ marginTop: '8px', marginLeft: '8px', paddingLeft: '12px', borderLeft: `2px solid ${themeStyles.border}` }}>
                          {problems.length > 0 ? problems.map((prob, idx) => (
                            <div
                              key={prob.pid || idx}
                              style={{
                                marginBottom: '8px',
                                padding: '8px 12px',
                                fontSize: '12px',
                                color: themeStyles.textPrimary,
                                backgroundColor: themeStyles.bgSecondary,
                                borderRadius: '4px',
                                lineHeight: '1.5',
                              }}
                            >
                              <span style={{ color: themeStyles.textSecondary, marginRight: '6px' }}>{idx + 1}.</span>
                              {prob.stem || i18n('Unnamed question')}
                            </div>
                          )) : (
                            <div style={{ color: themeStyles.textSecondary, fontSize: '12px', fontStyle: 'italic' }}>
                              {i18n('No question details available')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                }
                return renderNode(item.data as LearnDAGNode, level + 1, false);
              })}
            </div>
          </div>
        )}
      </div>
    );
  }, [sections, dag, expandedNodes, expandedCards, currentSectionId, toggleExpand, toggleCardExpand, getLearnUrl, getLessonUrl, openSingleCardModal, openSingleNodeModal, themeStyles]);

  if (!sections || sections.length === 0) {
    return (
      <div style={{ padding: '24px 32px', textAlign: 'center', color: themeStyles.textSecondary, fontSize: '14px' }}>
        <p>{i18n('No sections available.')}</p>
        <p>{i18n('Please create a base with at least one section.')}</p>
      </div>
    );
  }

  const selectedSection = sections[selectedSectionIndex];

  const sidebarInner = (
    <>
      <div style={{ padding: '0 16px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: '600', color: themeStyles.textSecondary, textTransform: 'uppercase' }}>
          {i18n('Sections')}
        </span>
        <a
          href={`/d/${domainId}/learn/section/edit?uid=${(window as any).UserContext?._id ?? ''}`}
          style={{
            fontSize: '12px',
            color: themeStyles.accent,
            textDecoration: 'none',
          }}
          title={i18n('Section Order')}
        >
          {i18n('Section Order')}
        </a>
      </div>
      {sections.map((section, index) => {
        const isSelected = selectedSectionIndex === index;
        const isCurrent = typeof currentLearnSectionIndex === 'number'
          ? index === currentLearnSectionIndex
          : currentSectionId === section._id && index === sections.findIndex(s => s._id === currentSectionId);
        return (
          <div
            key={`${index}-${section._id}`}
            onClick={() => {
              setSelectedSectionIndex(index);
              if (isMobile) setSidebarOpen(false);
            }}
            style={{
              padding: isMobile ? '14px 16px' : '10px 16px',
              minHeight: isMobile ? '48px' : undefined,
              display: isMobile ? 'flex' : undefined,
              alignItems: isMobile ? 'center' : undefined,
              cursor: 'pointer',
              backgroundColor: isSelected ? themeStyles.bgHover : 'transparent',
              borderLeft: `3px solid ${isSelected ? themeStyles.accent : 'transparent'}`,
              color: isSelected ? themeStyles.accent : themeStyles.textPrimary,
              fontWeight: isSelected ? '600' : 'normal',
              fontSize: '14px',
              transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => {
              if (!isSelected) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            {section.title}
            {isCurrent && (
              <span style={{ color: '#4CAF50', fontSize: '0.75em', marginLeft: '6px' }}>
                ({i18n('Current Progress')})
              </span>
            )}
          </div>
        );
      })}
    </>
  );

  const asideBaseStyle = {
    backgroundColor: themeStyles.bgSidebar,
    borderRight: `1px solid ${themeStyles.border}`,
    overflowY: 'auto' as const,
    padding: '12px 0',
  };

  return (
    <>
    {isMobile && (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '48px',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: '12px',
          paddingRight: '12px',
          backgroundColor: themeStyles.bgSidebar,
          borderBottom: `1px solid ${themeStyles.border}`,
        }}
      >
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            minHeight: '44px',
            fontSize: '14px',
            fontWeight: 500,
            color: themeStyles.textPrimary,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '8px',
          }}
        >
          ☰ {i18n('Sections')}
        </button>
      </div>
    )}

    {isMobile && sidebarOpen && (
      <div
        role="presentation"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1001,
          backgroundColor: 'rgba(0,0,0,0.4)',
        }}
        onClick={() => setSidebarOpen(false)}
      />
    )}

    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        minHeight: 'calc(100vh - 120px)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        backgroundColor: themeStyles.bgPrimary,
        paddingTop: isMobile ? '56px' : 0,
      }}
    >
      {/* 侧边栏：根节点列表（桌面常显，移动端为抽屉） */}
      <aside
        style={{
          ...asideBaseStyle,
          ...(isMobile
            ? {
                position: 'fixed' as const,
                left: 0,
                top: 0,
                bottom: 0,
                width: '280px',
                maxWidth: '85vw',
                zIndex: 1002,
                transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
                transition: 'transform 0.2s ease',
                boxShadow: sidebarOpen ? (theme === 'dark' ? '4px 0 16px rgba(0,0,0,0.4)' : '4px 0 16px rgba(0,0,0,0.1)') : 'none',
              }
            : {
                width: '220px',
                flexShrink: 0,
              }),
        }}
      >
        {isMobile && (
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${themeStyles.border}`, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              style={{
                padding: '8px 12px',
                fontSize: '14px',
                color: themeStyles.textPrimary,
                background: 'transparent',
                border: `1px solid ${themeStyles.border}`,
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              {i18n('Close')}
            </button>
          </div>
        )}
        {sidebarInner}
      </aside>

      {/* 主内容区：选中章节的树形大纲 */}
      <main
        style={{
          flex: 1,
          padding: isMobile ? '16px 12px' : '24px 32px',
          overflowY: 'auto',
          backgroundColor: themeStyles.bgPrimary,
        }}
      >
        {selectedSection ? (
          <>
            <div
              style={{
                fontSize: isMobile ? '18px' : '20px',
                fontWeight: '600',
                color: themeStyles.textPrimary,
                marginBottom: isMobile ? '16px' : '24px',
                paddingBottom: isMobile ? '12px' : '16px',
                borderBottom: `1px solid ${themeStyles.border}`,
              }}
            >
              {selectedSection.title}
            </div>
            <div style={{ paddingLeft: isMobile ? '0' : '4px' }}>
              {renderNode(selectedSection, 0, typeof currentLearnSectionIndex === 'number'
                ? selectedSectionIndex === currentLearnSectionIndex
                : currentSectionId === selectedSection._id && selectedSectionIndex === sections.findIndex(s => s._id === currentSectionId))}
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: themeStyles.textSecondary, padding: isMobile ? '24px 12px' : '40px 20px' }}>
            {i18n('Select a section from the sidebar')}
          </div>
        )}
      </main>
    </div>

    {/* 单卡片模式确认弹窗 */}
    {singleCardModal && (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="single-card-modal-title"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.5)',
        }}
        onClick={() => setSingleCardModal(null)}
      >
        <div
          style={{
            background: themeStyles.bgPrimary,
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '360px',
            width: '90%',
            boxShadow: theme === 'dark' ? '0 8px 32px rgba(0,0,0,0.5)' : '0 8px 24px rgba(0,0,0,0.15)',
            border: `1px solid ${themeStyles.border}`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3
            id="single-card-modal-title"
            style={{
              margin: '0 0 12px',
              fontSize: '16px',
              fontWeight: 600,
              color: themeStyles.textPrimary,
            }}
          >
            {i18n('Enter single card mode?')}
          </h3>
          <p style={{ margin: '0 0 20px', fontSize: '14px', color: themeStyles.textSecondary, lineHeight: 1.5 }}>
            {i18n('Open practice for card: {0}').format(singleCardModal.title)}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              type="button"
              onClick={() => setSingleCardModal(null)}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 500,
                color: themeStyles.textPrimary,
                background: themeStyles.bgSecondary,
                border: `1px solid ${themeStyles.border}`,
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              {i18n('Cancel')}
            </button>
            <button
              type="button"
              onClick={confirmSingleCardMode}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 600,
                color: '#fff',
                background: themeStyles.accent,
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              {i18n('Confirm')}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* 单 node 模式确认弹窗 */}
    {singleNodeModal && (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="single-node-modal-title"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.5)',
        }}
        onClick={() => setSingleNodeModal(null)}
      >
        <div
          style={{
            background: themeStyles.bgPrimary,
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '360px',
            width: '90%',
            boxShadow: theme === 'dark' ? '0 8px 32px rgba(0,0,0,0.5)' : '0 8px 24px rgba(0,0,0,0.15)',
            border: `1px solid ${themeStyles.border}`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3
            id="single-node-modal-title"
            style={{
              margin: '0 0 12px',
              fontSize: '16px',
              fontWeight: 600,
              color: themeStyles.textPrimary,
            }}
          >
            {i18n('Enter single node mode?')}
          </h3>
          <p style={{ margin: '0 0 20px', fontSize: '14px', color: themeStyles.textSecondary, lineHeight: 1.5 }}>
            {i18n('Open practice for node: {0}').format(singleNodeModal.title)}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              type="button"
              onClick={() => setSingleNodeModal(null)}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 500,
                color: themeStyles.textPrimary,
                background: themeStyles.bgSecondary,
                border: `1px solid ${themeStyles.border}`,
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              {i18n('Cancel')}
            </button>
            <button
              type="button"
              onClick={confirmSingleNodeMode}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 600,
                color: '#fff',
                background: themeStyles.accent,
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              {i18n('Confirm')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

const page = new NamedPage('learnSectionsPage', async () => {
  try {
    const container = document.getElementById('learn-sections-container');
    if (!container) return;

    const sections = (window as any).UiContext?.sections || [];
    const dag = (window as any).UiContext?.dag || [];
    const domainId = (window as any).UiContext?.domainId || 'system';
    const currentSectionId = (window as any).UiContext?.currentSectionId || null;
    const currentLearnSectionIndex = (window as any).UiContext?.currentLearnSectionIndex ?? null;

    ReactDOM.render(
      <LearnSectionsTree
        sections={sections}
        dag={dag}
        domainId={domainId}
        currentSectionId={currentSectionId}
        currentLearnSectionIndex={currentLearnSectionIndex}
      />,
      container
    );
  } catch (error: any) {
    console.error('Failed to render learn sections page:', error);
  }
});

export default page;

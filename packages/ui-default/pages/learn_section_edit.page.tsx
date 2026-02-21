import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import UiNotification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';
import { i18n } from 'vj/utils';

interface LearnCard {
  cardId: string;
  title: string;
  order?: number;
  problemCount?: number;
}

interface LearnDAGNode {
  _id: string;
  title: string;
  requireNids: string[];
  cards: LearnCard[];
  order?: number;
}

function getChildren(nodeId: string, allSections: LearnDAGNode[], dag: LearnDAGNode[]): LearnDAGNode[] {
  const children: LearnDAGNode[] = [];
  dag.forEach(n => {
    const parentId = n.requireNids?.[n.requireNids.length - 1];
    if (parentId === nodeId) children.push(n);
  });
  return children.sort((a, b) => (a.order || 0) - (b.order || 0));
}

interface LearnSectionEditProps {
  sections: LearnDAGNode[];
  allSections: LearnDAGNode[];
  dag: LearnDAGNode[];
  domainId: string;
  targetUid: number;
  targetUser: { uname: string; _id: number } | null;
  currentLearnSectionIndex?: number | null;
  currentLearnSectionId?: string | null;
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

const MOBILE_BREAKPOINT = 768;

function LearnSectionEdit({ sections: initialSections, allSections: allSectionsProp = [], dag: dagProp = [], domainId, targetUid, targetUser, currentLearnSectionIndex: initialLearnIndex = null, currentLearnSectionId: initialLearnId = null }: LearnSectionEditProps) {
  const [sections, setSections] = useState<LearnDAGNode[]>(initialSections || []);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(getTheme);
  const [sidebarExpanded, setSidebarExpanded] = useState<Set<string>>(() => new Set());
  const [currentLearnSectionIndex, setCurrentLearnSectionIndex] = useState<number | null>(initialLearnIndex ?? null);
  const draggedIndexRef = useRef<number | null>(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const allSections = allSectionsProp || [];
  const dag = dagProp || [];

  useEffect(() => {
    if (typeof initialLearnIndex === 'number') setCurrentLearnSectionIndex(initialLearnIndex);
    else if (initialLearnId && initialSections?.length) {
      const idx = initialSections.findIndex(s => String(s._id) === String(initialLearnId));
      if (idx >= 0) setCurrentLearnSectionIndex(idx);
    }
  }, [initialLearnIndex, initialLearnId, initialSections]);

  useEffect(() => {
    if (initialSections && initialSections.length > 0) {
      const sorted = [...initialSections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setSections([...sorted].reverse());
    }
  }, []); // 仅挂载时同步，与 column-reverse 显示一致：顶部=第一个学习

  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) setTheme(newTheme);
    };
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const leftEl = document.getElementById('header-mobile-extra-left');
    if (!leftEl) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-mobile-extra-btn';
    btn.textContent = '☰ ' + (i18n('Sections') || '章节');
    btn.onclick = () => setMobileSidebarOpen(open => !open);
    leftEl.appendChild(btn);
    return () => { btn.remove(); };
  }, [isMobile]);

  const themeStyles = useMemo(() => ({
    bgPrimary: theme === 'dark' ? '#1e1e1e' : '#fff',
    bgSecondary: theme === 'dark' ? '#2d2d2d' : '#f6f8fa',
    bgHover: theme === 'dark' ? '#404040' : '#e8eaed',
    bgDragOver: theme === 'dark' ? '#1e3a5f' : '#e3f2fd',
    bgDragged: theme === 'dark' ? '#2a2a2a' : '#f0f0f0',
    textPrimary: theme === 'dark' ? '#fff' : '#24292e',
    textSecondary: theme === 'dark' ? '#bdbdbd' : '#586069',
    border: theme === 'dark' ? '#404040' : '#e1e4e8',
    accent: theme === 'dark' ? '#64b5f6' : '#1976d2',
    success: theme === 'dark' ? '#4caf50' : '#2e7d32',
    error: theme === 'dark' ? '#f44336' : '#d32f2f',
    warning: theme === 'dark' ? '#ff9800' : '#ed6c02',
  }), [theme]);

  const [savedSectionIds, setSavedSectionIds] = useState<string[]>(() =>
    (initialSections || []).map(s => String(s._id))
  );

  const hasUnsavedChanges = useMemo(() => {
    const current = [...sections].reverse().map(s => String(s._id));
    if (current.length !== savedSectionIds.length) return true;
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== savedSectionIds[i]) return true;
    }
    return false;
  }, [sections, savedSectionIds]);

  const pendingChanges = useMemo(() => {
    const currentOrder = [...sections].reverse().map(s => String(s._id));
    const currentIds = new Set(currentOrder);
    const countMap: Record<string, number> = {};
    savedSectionIds.forEach(id => { countMap[id] = (countMap[id] || 0) + 1; });
    const addedIndices = new Set<number>();
    const added: LearnDAGNode[] = [];
    currentOrder.forEach((id, i) => {
      const saved = countMap[id] || 0;
      if (saved > 0) {
        countMap[id]--;
      } else {
        const sectionIndex = sections.length - 1 - i;
        addedIndices.add(sectionIndex);
        const section = sections.find(s => String(s._id) === id);
        if (section) added.push(section);
      }
    });
    const removed = savedSectionIds.filter(id => !currentIds.has(id)).map(id => {
      const n = allSections.find(s => String(s._id) === id) || { _id: id, title: (id as string).slice(0, 8) + '...' } as LearnDAGNode;
      return n;
    });
    const reordered = added.length === 0 && removed.length === 0 && sections.length > 0 &&
      (currentOrder.join(',') !== savedSectionIds.join(','));
    return { added, removed, reordered, addedIndices };
  }, [sections, savedSectionIds, allSections]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    draggedIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleOrderDragOver = useCallback((e: React.DragEvent, insertIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (draggedIndex !== null && insertIndex !== draggedIndex && insertIndex !== draggedIndex + 1) {
      setDragOverIndex(insertIndex);
    }
  }, [draggedIndex]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (!related) return;
    if (e.currentTarget.contains(related)) return;
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const fromList = draggedIndexRef.current;
    if (fromList === null) return;
    setDragOverIndex(null);
    draggedIndexRef.current = null;
    if (fromList === targetIndex) {
      setDraggedIndex(null);
      return;
    }
    setSections(prev => {
      const next = [...prev];
      const [removed] = next.splice(fromList, 1);
      const insertAt = fromList < targetIndex ? Math.min(targetIndex - 1, next.length) : Math.min(targetIndex, next.length);
      next.splice(insertAt, 0, removed);
      next.forEach((s, i) => { s.order = i; });
      return next;
    });
    setDraggedIndex(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    setDraggedIndex(null);
    draggedIndexRef.current = null;
  }, []);

  const handleSidebarSectionClick = useCallback((section: LearnDAGNode) => {
    setSections(prev => {
      const newItem = { ...section, order: prev.length };
      const next = [...prev, newItem];
      return next.map((s, i) => ({ ...s, order: i }));
    });
    if (isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  const toggleSidebarExpand = useCallback((id: string) => {
    setSidebarExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const removeSection = useCallback((index: number) => {
    setSections(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      // 与「设置学习点」约定一致：sectionOrder[0]=先学(顶部)，顺序可含重复
      const sectionOrder = [...sections].reverse().map(s => String(s._id));
      const body: Record<string, unknown> = { sectionOrder };
      if (typeof currentLearnSectionIndex === 'number') {
        body.currentLearnSectionIndex = currentLearnSectionIndex;
      }
      if (targetUid && targetUid !== (window as any).UserContext?._id) {
        body.uid = targetUid;
      }
      await request.post(`/d/${domainId}/learn/section/edit`, body);
      setSavedSectionIds(sectionOrder);
      UiNotification.success(i18n('Saved successfully') || '保存成功');
    } catch (err: any) {
      UiNotification.error(err?.message || i18n('Save failed') || '保存失败');
    } finally {
      setIsSaving(false);
    }
  }, [domainId, sections, currentLearnSectionIndex]);

  const handleSetLearningPoint = useCallback(async (index: number) => {
    if (index < 0 || index >= sections.length) return;
    setIsSaving(true);
    try {
      // sectionOrder = reverse(sections)：sectionOrder[0]=先学(顶部)，sectionOrder[length-1]=后学(底部)
      // column-reverse：顶部=index 3(第1个)，底部=index 0(第4个) → learnSectionIndex = length-1-index
      const sectionOrder = [...sections].reverse().map(s => String(s._id));
      const learnSectionIndex = sections.length - 1 - index;
      const body: Record<string, unknown> = {
        sectionOrder,
        currentLearnSectionIndex: learnSectionIndex,
      };
      if (targetUid && targetUid !== (window as any).UserContext?._id) {
        body.uid = targetUid;
      }
      await request.post(`/d/${domainId}/learn/section/edit`, body);
      setCurrentLearnSectionIndex(learnSectionIndex);
      setSavedSectionIds(sectionOrder);
      UiNotification.success(i18n('Learning point set') || '学习点已设置');
    } catch (err: any) {
      UiNotification.error(err?.message || i18n('Failed to set learning point') || '设置学习点失败');
    } finally {
      setIsSaving(false);
    }
  }, [domainId, sections, targetUid]);

  if (allSections.length === 0) {
    return (
      <div style={{
        padding: '40px 24px',
        textAlign: 'center',
        color: themeStyles.textSecondary,
        fontSize: '15px',
        backgroundColor: themeStyles.bgPrimary,
      }}>
        <p>{i18n('No sections available.')}</p>
        <p style={{ marginTop: '8px', fontSize: '13px' }}>
          {i18n('Please create a base with at least one section first.')}
        </p>
        <a
          href={`/d/${domainId}/learn/sections`}
          style={{ color: themeStyles.accent, marginTop: '16px', display: 'inline-block' }}
        >
          {i18n('Back to Sections')}
        </a>
        {targetUid && (
          <p style={{ marginTop: '12px', fontSize: '13px', color: themeStyles.textSecondary }}>
            {i18n('Editing for user')}: {targetUser?.uname || targetUid}
          </p>
        )}
      </div>
    );
  }

  const renderSidebarNode = (node: LearnDAGNode, level: number, isSection: boolean) => {
    const children = getChildren(node._id, allSections, dag);
    const cards = node.cards || [];
    const expanded = sidebarExpanded.has(node._id);
    const hasChildren = children.length > 0 || cards.length > 0;

    return (
      <div key={node._id} style={{ marginLeft: level * 12 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '6px 8px',
            borderRadius: '6px',
            marginBottom: '2px',
            border: isSection ? `1px solid ${themeStyles.border}` : 'none',
          }}
        >
          {hasChildren && (
            <button
              type="button"
              onClick={() => toggleSidebarExpand(node._id)}
              style={{
                width: isMobile ? 36 : 20,
                height: isMobile ? 36 : 20,
                minHeight: isMobile ? 36 : undefined,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: themeStyles.textSecondary,
                cursor: 'pointer',
                fontSize: '12px',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {expanded ? '▼' : '▶'}
            </button>
          )}
          {!hasChildren && <span style={{ width: isMobile ? 36 : 20, display: 'inline-block', flexShrink: 0 }} />}
          <span style={{
            fontSize: isSection ? 14 : 13,
            fontWeight: isSection ? 600 : 400,
            color: themeStyles.textPrimary,
            flex: 1,
          }}>
            {node.title || i18n('Unnamed')}
          </span>
          {isSection && (node.cards?.length ?? 0) > 0 && (
            <span style={{ fontSize: 11, color: themeStyles.textSecondary, marginLeft: 6 }}>
              {node.cards.length} {i18n('cards')}
            </span>
          )}
          {isSection && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleSidebarSectionClick(node); }}
              title={i18n('Add to top of order')}
              style={{
                width: isMobile ? 36 : 24,
                height: isMobile ? 36 : 24,
                minHeight: isMobile ? 36 : undefined,
                padding: 0,
                marginLeft: '6px',
                border: `1px solid ${themeStyles.border}`,
                borderRadius: '4px',
                background: themeStyles.bgPrimary,
                color: themeStyles.accent,
                cursor: 'pointer',
                fontSize: '16px',
                lineHeight: 1,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              +
            </button>
          )}
        </div>
        {expanded && (
          <>
            {children.map(child => renderSidebarNode(child, level + 1, false))}
            {cards.map(card => (
              <div
                key={card.cardId}
                style={{
                  marginLeft: (level + 1) * 12,
                  padding: '4px 8px',
                  fontSize: 12,
                  color: themeStyles.textSecondary,
                }}
              >
                📎 {card.title || i18n('Unnamed Card')}
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      minHeight: isMobile ? '100dvh' : 'calc(100vh - 120px)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: themeStyles.bgPrimary,
      paddingTop: isMobile ? 'env(safe-area-inset-top, 0px)' : undefined,
      paddingLeft: isMobile ? 'env(safe-area-inset-left, 0px)' : undefined,
      paddingRight: isMobile ? 'env(safe-area-inset-right, 0px)' : undefined,
      paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 0px)' : undefined,
    }}>
      {isMobile && mobileSidebarOpen && (
        <div
          role="presentation"
          onClick={() => setMobileSidebarOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
            zIndex: 1001,
          }}
        />
      )}
      {/* 左侧边栏：桌面固定宽度，移动端为抽屉 */}
      <aside style={{
        ...(isMobile
          ? {
              position: 'fixed',
              left: 0,
              top: 0,
              bottom: 0,
              width: 'min(280px, 85vw)',
              zIndex: 1002,
              transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease',
              boxShadow: mobileSidebarOpen ? '4px 0 16px rgba(0,0,0,0.15)' : 'none',
            }
          : {
              width: '260px',
              flexShrink: 0,
            }),
        backgroundColor: themeStyles.bgSecondary,
        borderRight: `1px solid ${themeStyles.border}`,
        overflowY: 'auto',
        padding: '12px',
      }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: themeStyles.textSecondary,
          marginBottom: '10px',
          paddingBottom: '8px',
          borderBottom: `1px solid ${themeStyles.border}`,
        }}>
          {i18n('All sections & cards')}
        </div>
        <div style={{ fontSize: 12, color: themeStyles.textSecondary, marginBottom: '8px' }}>
          {i18n('Click a section to add it to the top of the order list.')}
        </div>

        {/* 待更新 */}
        {hasUnsavedChanges && (
          <div style={{
            marginBottom: '12px',
            padding: '10px',
            borderRadius: '6px',
            backgroundColor: themeStyles.warning + '20',
            border: `1px dashed ${themeStyles.warning}`,
          }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: themeStyles.warning, marginBottom: '8px' }}>
              {i18n('Pending changes')}
            </div>
            <div style={{ fontSize: 11, color: themeStyles.textSecondary }}>
              {pendingChanges.added.length > 0 && (
                <div style={{ marginBottom: '4px' }}>
                  <span style={{ color: themeStyles.success }}>{i18n('Added')}</span> ({pendingChanges.added.length}): {pendingChanges.added.slice(0, 3).map(s => s.title || s._id).join(', ')}{pendingChanges.added.length > 3 ? '...' : ''}
                </div>
              )}
              {pendingChanges.removed.length > 0 && (
                <div style={{ marginBottom: '4px' }}>
                  <span style={{ color: themeStyles.error }}>{i18n('Removed')}</span> ({pendingChanges.removed.length}): {pendingChanges.removed.slice(0, 3).map(s => s.title || s._id).join(', ')}{pendingChanges.removed.length > 3 ? '...' : ''}
                </div>
              )}
              {pendingChanges.reordered && (
                <div style={{ marginBottom: '4px' }}>
                  <span style={{ color: themeStyles.warning }}>{i18n('Order changed')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {allSections.map(section => renderSidebarNode(section, 0, true))}
      </aside>

      {/* 右侧主内容：标题 + 学习顺序列表 */}
      <main
        onDragOver={(e) => {
          if (draggedIndex !== null) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        style={{
          flex: 1,
          padding: isMobile ? '16px 16px max(16px, env(safe-area-inset-bottom, 0px))' : '24px 32px',
          paddingTop: isMobile ? 'max(16px, env(safe-area-inset-top, 0px))' : undefined,
          overflowY: 'auto',
          minWidth: 0,
        }}
      >
        <div style={{
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
        }}>
          <div>
            <h1 style={{
              fontSize: '22px',
              fontWeight: 600,
              color: themeStyles.textPrimary,
              margin: 0,
            }}>
              {i18n('Section Order') || '学习顺序'}
              {targetUser && (
                <span style={{ fontSize: '16px', fontWeight: 'normal', color: themeStyles.textSecondary, marginLeft: '12px' }}>
                  ({i18n('User')}: {targetUser.uname})
                </span>
              )}
            </h1>
            <p style={{
              margin: '8px 0 0',
              fontSize: '14px',
              color: themeStyles.textSecondary,
            }}>
              {i18n('Drag to reorder sections. The order affects this user\'s learning sequence.')}
              {i18n(' Click "Set as start" to set where learning begins from.')}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !hasUnsavedChanges}
              style={{
                padding: isMobile ? '10px 16px' : '10px 20px',
                minHeight: isMobile ? 44 : undefined,
                fontSize: '14px',
                fontWeight: 600,
                color: '#fff',
                backgroundColor: isSaving ? themeStyles.textSecondary : (hasUnsavedChanges ? themeStyles.accent : themeStyles.textSecondary),
                border: 'none',
                borderRadius: '6px',
                cursor: isSaving || !hasUnsavedChanges ? 'not-allowed' : 'pointer',
              }}
            >
              {isSaving ? (i18n('Saving...') || '保存中...') : (i18n('Save') || '保存')}
            </button>
            <a
              href={`/d/${domainId}/learn/sections`}
              style={{
                padding: isMobile ? '10px 16px' : '10px 20px',
                minHeight: isMobile ? 44 : undefined,
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: '14px',
                color: themeStyles.textPrimary,
                backgroundColor: themeStyles.bgSecondary,
                border: `1px solid ${themeStyles.border}`,
                borderRadius: '6px',
                textDecoration: 'none',
              }}
            >
              {i18n('Back to Sections')}
            </a>
            {targetUid && targetUid !== (window as any).UserContext?._id && (
              <a
                href={`/d/${domainId}/learn/section/edit`}
                style={{
                  padding: isMobile ? '10px 16px' : '10px 20px',
                  minHeight: isMobile ? 44 : undefined,
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '14px',
                  color: themeStyles.accent,
                  textDecoration: 'none',
                }}
              >
                {i18n('Edit my order')}
              </a>
            )}
          </div>
        </div>

        <div style={{ maxWidth: '800px' }}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (draggedIndex !== null) e.dataTransfer.dropEffect = 'move';
            }}
            style={{
              border: hasUnsavedChanges ? `2px dashed ${themeStyles.warning}` : `1px solid ${themeStyles.border}`,
              borderRadius: '8px',
              overflow: 'hidden',
              backgroundColor: themeStyles.bgSecondary,
              padding: '12px',
              display: 'flex',
              flexDirection: 'column-reverse',
            }}
          >
        {sections.length === 0 ? (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: themeStyles.textSecondary,
              border: `2px dashed ${themeStyles.border}`,
              borderRadius: '6px',
              margin: '12px',
            }}
          >
            {i18n('Click a section on the left to add to the top of the order.')}
          </div>
        ) : null}
        {sections.map((section, index) => (
          <React.Fragment key={`${section._id}-${index}`}>
            {/* 插入槽：拖入此处插入到 index 位置 */}
            <div
              onDragOver={(e) => handleOrderDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              style={{
                height: dragOverIndex === index ? '40px' : '20px',
                minHeight: '20px',
                backgroundColor: dragOverIndex === index ? themeStyles.bgDragOver : 'transparent',
                borderTop: dragOverIndex === index ? `3px solid ${themeStyles.accent}` : '2px dashed transparent',
                transition: 'height 0.15s, background-color 0.15s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                color: dragOverIndex === index ? themeStyles.accent : 'transparent',
              }}
            >
              {dragOverIndex === index ? (i18n('Insert here') || '插入此处') : ''}
            </div>
            <div
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleOrderDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '14px 20px',
                margin: '0 12px 0 12px',
                borderRadius: '6px',
                borderBottom: index < sections.length - 1 ? 'none' : 'none',
                backgroundColor: dragOverIndex === index
                  ? themeStyles.bgDragOver
                  : draggedIndex === index
                    ? themeStyles.bgDragged
                    : 'transparent',
                border: pendingChanges.addedIndices.has(index)
                  ? `2px dashed ${themeStyles.warning}`
                  : `1px solid ${themeStyles.border}`,
                marginBottom: index < sections.length - 1 ? '4px' : 0,
                cursor: 'grab',
                opacity: draggedIndex === index ? 0.7 : 1,
                transition: 'background-color 0.15s, border 0.15s',
              }}
            >
            <div style={{
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: '16px',
              flexShrink: 0,
              color: themeStyles.textSecondary,
              fontSize: '14px',
              fontWeight: 600,
              backgroundColor: themeStyles.bgPrimary,
              borderRadius: '6px',
              border: `1px solid ${themeStyles.border}`,
            }}>
              {sections.length - index}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: '15px',
                fontWeight: 500,
                color: themeStyles.textPrimary,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}>
                {section.title || i18n('Unnamed Section')}
                {currentLearnSectionIndex === sections.length - 1 - index && (
                  <span style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    backgroundColor: themeStyles.accent + '30',
                    color: themeStyles.accent,
                    fontWeight: 600,
                  }}>
                    {i18n('Learning start')}
                  </span>
                )}
              </div>
              {(section.cards?.length ?? 0) > 0 && (
                <div style={{
                  fontSize: '12px',
                  color: themeStyles.textSecondary,
                  marginTop: '4px',
                }}>
                  {section.cards.length} {i18n('cards')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleSetLearningPoint(index); }}
                disabled={isSaving || currentLearnSectionIndex === sections.length - 1 - index}
                title={i18n('Set as start')}
                style={{
                  width: isMobile ? 40 : 32,
                  height: isMobile ? 40 : 32,
                  minHeight: isMobile ? 40 : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${themeStyles.border}`,
                  borderRadius: '4px',
                  backgroundColor: currentLearnSectionIndex === sections.length - 1 - index ? themeStyles.accent + '30' : themeStyles.bgPrimary,
                  color: currentLearnSectionIndex === sections.length - 1 - index ? themeStyles.accent : themeStyles.textSecondary,
                  cursor: isSaving || currentLearnSectionIndex === sections.length - 1 - index ? 'not-allowed' : 'pointer',
                  fontSize: '14px',
                }}
              >
                ▶
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeSection(index); }}
                title={i18n('Remove from order')}
                style={{
                  width: isMobile ? 40 : 32,
                  height: isMobile ? 40 : 32,
                  minHeight: isMobile ? 40 : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${themeStyles.border}`,
                  borderRadius: '4px',
                  backgroundColor: themeStyles.bgPrimary,
                  color: themeStyles.error,
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                ×
              </button>
            </div>
          </div>
          </React.Fragment>
        ))}
            {sections.length > 0 && (
              <div
                onDragOver={(e) => handleOrderDragOver(e, sections.length)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, sections.length)}
                style={{
                  height: dragOverIndex === sections.length ? '40px' : '20px',
                  minHeight: '20px',
                  backgroundColor: dragOverIndex === sections.length ? themeStyles.bgDragOver : 'transparent',
                  borderTop: dragOverIndex === sections.length ? `3px solid ${themeStyles.accent}` : '2px dashed transparent',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  color: dragOverIndex === sections.length ? themeStyles.accent : 'transparent',
                }}
              >
                {dragOverIndex === sections.length ? (i18n('Insert here') || '插入此处') : ''}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

const page = new NamedPage('learnSectionEditPage', async () => {
  try {
    const container = document.getElementById('learn-section-edit-container');
    if (!container) return;

    const sections = (window as any).UiContext?.sections || [];
    const allSections = (window as any).UiContext?.allSections || [];
    const dag = (window as any).UiContext?.dag || [];
    const domainId = (window as any).UiContext?.domainId || 'system';
    const targetUid = (window as any).UiContext?.targetUid ?? (window as any).UserContext?._id;
    const targetUser = (window as any).UiContext?.targetUser || null;
    const currentLearnSectionIndex = (window as any).UiContext?.currentLearnSectionIndex ?? null;
    const currentLearnSectionId = (window as any).UiContext?.currentLearnSectionId ?? null;

    ReactDOM.render(
      <LearnSectionEdit
        sections={sections}
        allSections={allSections}
        dag={dag}
        domainId={domainId}
        targetUid={targetUid}
        targetUser={targetUser}
        currentLearnSectionIndex={currentLearnSectionIndex}
        currentLearnSectionId={currentLearnSectionId}
      />,
      container
    );
  } catch (error: any) {
    console.error('Failed to render learn section edit page:', error);
  }
});

export default page;

import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

interface MindMapNode {
  id: string;
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  level?: number;
  style?: Record<string, any>;
  data?: Record<string, any>;
}

interface MindMapEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: Record<string, any>;
  type?: 'straight' | 'curved' | 'bezier';
  color?: string;
  width?: number;
}

interface MindMapDoc {
  docId: string;
  mmid: number;
  title: string;
  content: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
  layout?: {
    type: 'hierarchical' | 'force' | 'manual';
    direction?: 'LR' | 'RL' | 'TB' | 'BT';
    spacing?: { x: number; y: number };
    config?: Record<string, any>;
  };
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
  theme?: {
    primaryColor?: string;
    backgroundColor?: string;
    nodeStyle?: Record<string, any>;
    edgeStyle?: Record<string, any>;
  };
  owner: number;
  createdAt: string;
  updateAt: string;
  views: number;
  githubRepo?: string;
  branches?: string[];
  currentBranch?: string;
}

// Card 接口
interface Card {
  docId: string;
  cid: number;
  title: string;
  content: string;
  updateAt: string;
  createdAt?: string;
  order?: number;
  nodeId?: string;
}

// FileItem 接口（用于文件树）
type FileItem = {
  type: 'node' | 'card';
  id: string;
  name: string;
  nodeId?: string;
  cardId?: string;
  parentId?: string;
  level: number;
  hasPendingChanges?: boolean;
  clipboardType?: 'copy' | 'cut';
};

const OutlineView = ({
  nodes,
  edges,
  onToggleExpand,
  onNodeClick,
  selectedNodeId,
}: {
  nodes: Node[];
  edges: Edge[];
  onToggleExpand: (nodeId: string) => void;
  onNodeClick: (nodeId: string) => void;
  selectedNodeId: string | null;
}) => {
  // 卡片展开状态管理（使用 localStorage 持久化）
  const getStorageKey = useCallback(() => {
    const docId = (window as any).UiContext?.mindMap?.docId;
    const mmid = (window as any).UiContext?.mindMap?.mmid;
    const domainId = (window as any).UiContext?.domainId || 'system';
    if (docId) {
      return `mindmap_cards_expanded_${domainId}_${docId}`;
    } else if (mmid) {
      return `mindmap_cards_expanded_${domainId}_mmid_${mmid}`;
    }
    return 'mindmap_cards_expanded_default';
  }, []);

  // 从 localStorage 加载卡片展开状态
  const loadCardsExpandedState = useCallback((): Record<string, boolean> => {
    try {
      const key = getStorageKey();
      const saved = localStorage.getItem(key);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load cards expanded state:', e);
    }
    return {};
  }, [getStorageKey]);

  // 保存卡片展开状态到 localStorage
  const saveCardsExpandedState = useCallback((state: Record<string, boolean>) => {
    try {
      const key = getStorageKey();
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save cards expanded state:', e);
    }
  }, [getStorageKey]);

  // 卡片展开状态
  const [cardsExpanded, setCardsExpanded] = useState<Record<string, boolean>>(() => {
    // 默认所有卡片都展开
    const loaded = loadCardsExpandedState();
    // 合并默认展开状态
    const defaultExpanded: Record<string, boolean> = {};
    nodes.forEach(node => {
      const nodeCards = (window as any).UiContext?.nodeCardsMap?.[node.id] || [];
      if (nodeCards.length > 0) {
        defaultExpanded[node.id] = loaded[node.id] !== undefined ? loaded[node.id] : true;
      }
    });
    return { ...loaded, ...defaultExpanded };
  });

  // 切换卡片展开状态
  const toggleCardsExpanded = useCallback((nodeId: string) => {
    setCardsExpanded(prev => {
      const newState = {
        ...prev,
        [nodeId]: !prev[nodeId],
      };
      saveCardsExpandedState(newState);
      return newState;
    });
  }, [saveCardsExpandedState]);

  // 当节点变化时，更新展开状态
  useEffect(() => {
    const loaded = loadCardsExpandedState();
    const newState: Record<string, boolean> = {};
    nodes.forEach(node => {
      const nodeCards = (window as any).UiContext?.nodeCardsMap?.[node.id] || [];
      if (nodeCards.length > 0) {
        newState[node.id] = loaded[node.id] !== undefined ? loaded[node.id] : true;
      }
    });
    setCardsExpanded(prev => {
      const updated = { ...prev };
      let changed = false;
      nodes.forEach(node => {
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[node.id] || [];
        if (nodeCards.length > 0 && updated[node.id] === undefined) {
          updated[node.id] = loaded[node.id] !== undefined ? loaded[node.id] : true;
          changed = true;
        }
      });
      return changed ? updated : prev;
    });
  }, [nodes, loadCardsExpandedState]);

  // 构建节点树结构
  const buildTree = useMemo(() => {
    const nodeMap = new Map<string, { node: Node; children: string[] }>();
    const rootNodes: string[] = [];

    // 初始化节点映射
    nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

    // 构建父子关系
    edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });

    // 找到根节点（没有父节点的节点）
    nodes.forEach((node) => {
      const hasParent = edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });

    return { nodeMap, rootNodes };
  }, [nodes, edges]);

  // 获取根节点信息（用于显示标题）
  const rootNodeInfo = useMemo(() => {
    if (buildTree.rootNodes.length === 0) return null;
    const rootNodeId = buildTree.rootNodes[0]; // 通常只有一个根节点
    const rootNodeData = buildTree.nodeMap.get(rootNodeId);
    if (!rootNodeData) return null;
    const originalNode = rootNodeData.node.data.originalNode as MindMapNode;
    return {
      id: rootNodeId,
      text: originalNode?.text || '未命名节点',
      children: rootNodeData.children,
    };
  }, [buildTree]);

  // 获取节点的所有可见子节点（递归）
  const getAllVisibleChildren = useCallback((nodeId: string): string[] => {
    const nodeData = buildTree.nodeMap.get(nodeId);
    if (!nodeData) return [];
    
    const { node, children } = nodeData;
    const originalNode = node.data.originalNode as MindMapNode;
    const expanded = originalNode?.expanded !== false;
    
    if (!expanded || children.length === 0) return [];
    
    const visibleChildren: string[] = [];
    children.forEach((childId) => {
      visibleChildren.push(childId);
      visibleChildren.push(...getAllVisibleChildren(childId));
    });
    
    return visibleChildren;
  }, [buildTree]);

  // 获取节点的卡片列表
  const getNodeCards = useCallback((nodeId: string): Card[] => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    return nodeCardsMap[nodeId] || [];
  }, []);

  // 构建卡片 URL
  const getCardUrl = useCallback((card: Card, nodeId: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = (window as any).UiContext?.currentBranch || 'main';
    const docId = (window as any).UiContext?.mindMap?.docId;
    const mmid = (window as any).UiContext?.mindMap?.mmid;
    
    if (docId) {
      return `/d/${domainId}/mindmap/${docId}/branch/${branch}/node/${nodeId}/cards?cardId=${card.docId}`;
    } else if (mmid) {
      return `/d/${domainId}/mindmap/mmid/${mmid}/branch/${branch}/node/${nodeId}/cards?cardId=${card.docId}`;
    }
    return '#';
  }, []);

  // 递归渲染节点树
  const renderNodeTree = useCallback(
    (nodeId: string, level: number = 0, isLast: boolean = false, hasSiblings: boolean = false): JSX.Element | null => {
      const nodeData = buildTree.nodeMap.get(nodeId);
      if (!nodeData) return null;

      const { node, children } = nodeData;
      const originalNode = node.data.originalNode as MindMapNode;
      const expanded = originalNode?.expanded !== false; // 默认为 true
      const hasChildren = children.length > 0;
      const isSelected = selectedNodeId === nodeId;
      
      // 获取节点的卡片列表
      const cards = getNodeCards(nodeId);
      const hasCards = cards.length > 0;
      const cardsExpandedState = cardsExpanded[nodeId] !== false; // 默认为 true（展开）

      return (
        <div key={nodeId} style={{ position: 'relative' }}>
          <div style={{ marginLeft: `${level * 24}px`, position: 'relative' }}>
            {/* 节点行 */}
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
                onClick={() => onNodeClick(nodeId)}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = '#f5f5f5';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                {/* 展开/折叠箭头按钮 */}
                {hasChildren ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand(nodeId);
                    }}
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
                      position: 'relative',
                      zIndex: 2,
                      color: '#666',
                    }}
                    title={expanded ? '折叠' : '展开'}
                  >
                    <span style={{ 
                      fontSize: '10px',
                      transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                      transition: 'transform 0.15s ease',
                      display: 'inline-block',
                      lineHeight: '1',
                    }}>
                      ▼
                    </span>
                  </button>
                ) : (
                  <div style={{ width: '22px', marginRight: '0px', flexShrink: 0 }} />
                )}
                
                {/* 项目符号（点） */}
                <span style={{ 
                  marginRight: '8px',
                  color: '#666',
                  fontSize: '12px',
                  flexShrink: 0,
                  lineHeight: '1',
                }}>
                  •
                </span>
                
                {/* 节点文本 */}
                <div
                  style={{
                    flex: 1,
                    color: isSelected ? '#1976d2' : (originalNode?.color || '#333'),
                    fontSize: `${originalNode?.fontSize || 14}px`,
                    fontWeight: isSelected ? '600' : 'normal',
                    lineHeight: '1.5',
                  }}
                >
                  {originalNode?.text || '未命名节点'}
                </div>
                
                {/* 卡片折叠/展开按钮 */}
                {hasCards && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      marginLeft: '8px',
                      flexShrink: 0,
                      position: 'relative',
                      zIndex: 2,
                    }}
                  >
                    {cardsExpandedState ? (
                      // 展开状态：显示箭头按钮（用于折叠）
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCardsExpanded(nodeId);
                        }}
                        style={{
                          width: '18px',
                          height: '18px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          color: '#666',
                        }}
                        title="折叠卡片"
                      >
                        <span style={{ 
                          fontSize: '10px',
                          transform: 'rotate(90deg)',
                          transition: 'transform 0.15s ease',
                          display: 'inline-block',
                          lineHeight: '1',
                        }}>
                          ▶
                        </span>
                      </button>
                    ) : (
                      // 折叠状态：显示带数字的圆按钮
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCardsExpanded(nodeId);
                        }}
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          border: '1px solid #4caf50',
                          background: '#fff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          color: '#4caf50',
                          fontSize: '11px',
                          fontWeight: '500',
                          lineHeight: '1',
                        }}
                        title="展开卡片"
                      >
                        {cards.length}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            {/* 卡片列表 */}
            {hasCards && cardsExpandedState && (
              <div style={{ 
                marginLeft: '40px', 
                marginTop: '4px', 
                marginBottom: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}>
                {cards.map((card) => (
                  <div
                    key={card.docId || card.cid}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onCardClick) {
                        onCardClick(card);
                      } else {
                        // 如果没有onCardClick，默认在新标签页打开
                        window.open(getCardUrl(card, nodeId), '_blank');
                      }
                    }}
                    style={{
                      display: 'inline-block',
                      padding: '4px 8px',
                      fontSize: '12px',
                      color: '#1976d2',
                      textDecoration: 'none',
                      borderRadius: '4px',
                      backgroundColor: '#f0f7ff',
                      border: '1px solid #e3f2fd',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      maxWidth: 'fit-content',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#e3f2fd';
                      e.currentTarget.style.textDecoration = 'underline';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#f0f7ff';
                      e.currentTarget.style.textDecoration = 'none';
                    }}
                    title={card.title}
                  >
                    {card.title || '未命名卡片'}
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {/* 子节点 */}
          {hasChildren && expanded && (
            <div style={{ position: 'relative', marginLeft: `${level * 24}px` }}>
              {/* 侧边垂直范围线 - 从父节点延伸到所有子节点 */}
              <div
                style={{
                  position: 'absolute',
                  left: '8px',
                  top: '0px',
                  bottom: '0px',
                  width: '1px',
                  backgroundColor: '#e0e0e0',
                  zIndex: 0,
                }}
              />
              <div>
                {children.map((childId, index) => {
                  const isLastChild = index === children.length - 1;
                  const childHasSiblings = children.length > 1;
                  return renderNodeTree(childId, level + 1, isLastChild, childHasSiblings);
                })}
              </div>
            </div>
          )}
        </div>
      );
    },
    [buildTree, selectedNodeId, onToggleExpand, onNodeClick, getNodeCards, getCardUrl, cardsExpanded, toggleCardsExpanded]
  );

  return (
    <div
      style={{
        padding: '24px 32px',
        backgroundColor: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        minHeight: '100%',
      }}
    >
      {!rootNodeInfo ? (
        <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '14px' }}>
          暂无节点
        </div>
      ) : (
        <>
          {/* 根节点作为标题 */}
          <div
            style={{
              fontSize: '20px',
              fontWeight: '600',
              color: '#333',
              marginBottom: '24px',
              paddingBottom: '16px',
              borderBottom: '1px solid #e0e0e0',
            }}
          >
            {rootNodeInfo.text}
          </div>
          {/* 从根节点的子节点开始展示，level 从 0 开始 */}
          {rootNodeInfo.children.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '14px' }}>
              暂无子节点
            </div>
          ) : (
            <div style={{ paddingLeft: '4px' }}>
              {rootNodeInfo.children.map((childId, index) => {
                const isLastChild = index === rootNodeInfo.children.length - 1;
                return renderNodeTree(childId, 0, isLastChild, rootNodeInfo.children.length > 1);
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

function MindMapOutlineEditor({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  const [mindMap, setMindMap] = useState<MindMapDoc>(initialData);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const initialExpanded = new Set<string>();
    if (initialData?.nodes) {
      initialData.nodes.forEach(node => {
        if (node.expanded !== false) {
          initialExpanded.add(node.id);
        }
      });
    }
    return initialExpanded;
  });

  // 卡片内容缓存
  const cardContentCacheRef = useRef<Record<string, string>>({});
  const imageCacheRef = useRef<Cache | null>(null);
  // 缓存状态：记录哪些card已经被缓存
  const cachedCardsRef = useRef<Set<string>>(new Set());
  // 缓存进度：记录正在缓存的进度
  const [cachingProgress, setCachingProgress] = useState<{ current: number; total: number } | null>(null);
  // 缓存控制：是否暂停缓存
  const [isCachingPaused, setIsCachingPaused] = useState(false);
  // 缓存管理侧边栏是否显示
  const [showCachePanel, setShowCachePanel] = useState(false);
  // 缓存任务是否正在运行
  const cachingTaskRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // 设置页面背景色
  useEffect(() => {
    document.body.style.backgroundColor = '#fff';
    const panel = document.getElementById('panel');
    if (panel) {
      (panel as HTMLElement).style.backgroundColor = '#fff';
    }
    return () => {
      document.body.style.backgroundColor = '';
      if (panel) {
        (panel as HTMLElement).style.backgroundColor = '';
      }
    };
  }, []);

  // 当 mindMap 更新时，更新展开状态
  useEffect(() => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      mindMap.nodes.forEach(node => {
        if (node.expanded !== false && !newSet.has(node.id)) {
          newSet.add(node.id);
        } else if (node.expanded === false && newSet.has(node.id)) {
          newSet.delete(node.id);
        }
      });
      return newSet;
    });
  }, [mindMap]);

  // 构建文件树
  const fileTree = useMemo(() => {
    const items: FileItem[] = [];
    const nodeMap = new Map<string, { node: MindMapNode; children: string[] }>();
    const rootNodes: string[] = [];

    // 初始化节点映射
    mindMap.nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

    // 构建父子关系
    mindMap.edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });

    // 找到根节点
    mindMap.nodes.forEach((node) => {
      const hasParent = mindMap.edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });

    // 获取最新的 nodeCardsMap
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};

    // 递归构建文件树
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node, children } = nodeData;
      const isExpanded = expandedNodes.has(nodeId);

      // 创建节点 FileItem
      const nodeFileItem: FileItem = {
        type: 'node',
        id: nodeId,
        name: node.text || '未命名节点',
        nodeId: nodeId,
        parentId,
        level,
      };
      items.push(nodeFileItem);

      // 如果节点展开，显示其卡片和子节点
      if (isExpanded) {
        // 获取该节点的卡片（按 order 排序）
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));

        // 添加卡片
        nodeCards.forEach((card: Card) => {
          const cardFileItem: FileItem = {
            type: 'card',
            id: `card-${card.docId}`,
            name: card.title || '未命名卡片',
            nodeId: card.nodeId || nodeId,
            cardId: card.docId,
            parentId: card.nodeId || nodeId,
            level: level + 1,
          };
          items.push(cardFileItem);
        });

        // 递归处理子节点
        children.forEach((childId) => {
          buildTree(childId, level + 1, nodeId);
        });
      }
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });

    return items;
  }, [mindMap.nodes, mindMap.edges, expandedNodes]);

  // 切换节点展开/折叠
  const toggleNodeExpanded = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return newSet;
    });
  }, []);

  // 使用ref来存储preloadCardContent函数，避免循环依赖和初始化顺序问题
  // const preloadCardContentRef = useRef<((card: Card) => Promise<void>) | null>(null);

  // 全量预加载所有card
  // const preloadAllCards = useCallback(async () => {
  //   if (isCachingPaused || cachingTaskRef.current.cancelled) {
  //     return;
  //   }

  //   const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
  //   const allCards: Card[] = [];
    
  //   // 收集所有card
  //   Object.values(nodeCardsMap).forEach((cards: Card[]) => {
  //     if (Array.isArray(cards)) {
  //       allCards.push(...cards);
  //     }
  //   });

  //   // 过滤掉已经缓存的card
  //   const cardsToPreload = allCards.filter(card => {
  //     const cardIdStr = String(card.docId);
  //     return !cachedCardsRef.current.has(cardIdStr);
  //   });

  //   if (cardsToPreload.length === 0) {
  //     setCachingProgress(null);
  //     return;
  //   }

  //   // 显示进度
  //   setCachingProgress({ current: 0, total: cardsToPreload.length });

  //   // 逐个预加载card
  //   for (let i = 0; i < cardsToPreload.length; i++) {
  //     // 检查是否暂停或取消
  //     if (isCachingPaused || cachingTaskRef.current.cancelled) {
  //       break;
  //     }

  //     const card = cardsToPreload[i];
      
  //     // 使用ref调用preloadCardContent
  //     if (preloadCardContentRef.current) {
  //       try {
  //         await preloadCardContentRef.current(card);
  //       } catch (error) {
  //         console.error(`Failed to preload card ${card.docId}:`, error);
  //       }
  //     }
      
  //     // 更新进度
  //     setCachingProgress({ current: i + 1, total: cardsToPreload.length });
  //   }

  //   // 如果完成或取消，隐藏进度
  //   if (!isCachingPaused && !cachingTaskRef.current.cancelled) {
  //     setCachingProgress(null);
  //   }
  // }, [isCachingPaused]);

  // 开始缓存
  // const startCaching = useCallback(() => {
  //   setIsCachingPaused(false);
  //   cachingTaskRef.current.cancelled = false;
  //   preloadAllCards();
  // }, [preloadAllCards]);

  // 暂停缓存
  // const pauseCaching = useCallback(() => {
  //   setIsCachingPaused(true);
  // }, []);

  // 删除缓存
  // const clearCache = useCallback(async () => {
  //   // 清空内容缓存
  //   cardContentCacheRef.current = {};
  //   cachedCardsRef.current.clear();
  //   setCachedCount(0);
    
  //   // 清空图片缓存
  //   if (imageCacheRef.current) {
  //     try {
  //       await caches.delete('mindmap-card-images-v1');
  //       imageCacheRef.current = null;
  //     } catch (error) {
  //       console.error('Failed to clear image cache:', error);
  //     }
  //   }
    
  //   // 重置进度
  //   setCachingProgress(null);
  //   cachingTaskRef.current.cancelled = true;
    
  //   Notification.success('缓存已清空');
  // }, []);

  // 计算缓存大小
  // const getCacheSize = useCallback(() => {
  //   let size = 0;
  //   Object.values(cardContentCacheRef.current).forEach((html: string) => {
  //     size += new Blob([html]).size;
  //   });
  //   return size;
  // }, []);

  // 格式化缓存大小
  // const formatCacheSize = useCallback((bytes: number) => {
  //   if (bytes < 1024) return bytes + ' B';
  //   if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  //   return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  // }, []);

  // 选择card
  const handleSelectCard = useCallback((card: Card, skipUrlUpdate = false) => {
    setSelectedCard(card);
    
    // 更新URL参数（除非skipUrlUpdate为true）
    if (!skipUrlUpdate) {
      const urlParams = new URLSearchParams(window.location.search);
      urlParams.set('cardId', String(card.docId));
      const newUrl = window.location.pathname + '?' + urlParams.toString();
      window.history.pushState({ cardId: card.docId }, '', newUrl);
    }
  }, []);

  // 根据URL参数加载对应的card
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    
    if (cardId && fileTree.length > 0) {
      // 在fileTree中查找对应的card
      const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
      if (cardFile) {
        // 从nodeCardsMap中获取card数据
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const nodeCards = nodeCardsMap[cardFile.nodeId || ''] || [];
        const card = nodeCards.find((c: Card) => c.docId === cardId);
        if (card && (!selectedCard || selectedCard.docId !== card.docId)) {
          handleSelectCard(card, true); // 跳过URL更新，避免循环
        }
      }
    }
  }, [fileTree, selectedCard, handleSelectCard]);

  // 监听浏览器前进/后退事件
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const urlParams = new URLSearchParams(window.location.search);
      const cardId = urlParams.get('cardId');
      
      if (cardId && fileTree.length > 0) {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
        if (cardFile) {
          const nodeCards = nodeCardsMap[cardFile.nodeId || ''] || [];
          const card = nodeCards.find((c: Card) => c.docId === cardId);
          if (card && (!selectedCard || selectedCard.docId !== card.docId)) {
            handleSelectCard(card, true); // 跳过URL更新，避免循环
          }
        }
      } else if (!cardId) {
        setSelectedCard(null);
      }
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [fileTree, selectedCard, handleSelectCard]);

  // 初始化图片缓存
  const initImageCache = useCallback(async () => {
    if ('caches' in window && !imageCacheRef.current) {
      try {
        imageCacheRef.current = await caches.open('mindmap-card-images-v1');
      } catch (error) {
        console.error('Failed to open cache:', error);
      }
    }
  }, []);

  // 从缓存或网络获取图片
  const getCachedImage = useCallback(async (url: string): Promise<string> => {
    if (!imageCacheRef.current) {
      await initImageCache();
    }
    
    if (!imageCacheRef.current) {
      return url;
    }
    
    try {
      const cachedResponse = await imageCacheRef.current.match(url);
      if (cachedResponse) {
        const blob = await cachedResponse.blob();
        return URL.createObjectURL(blob);
      }
      
      const response = await fetch(url);
      if (response.ok) {
        const responseClone = response.clone();
        await imageCacheRef.current.put(url, responseClone);
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      }
    } catch (error) {
      console.error(`Failed to cache image ${url}:`, error);
    }
    
    return url;
  }, [initImageCache]);

  // 预加载并缓存图片
  const preloadAndCacheImages = useCallback(async (html: string): Promise<string> => {
    if (!html) return html;
    
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const imageUrls: string[] = [];
    let match;
    
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
      if (url && !url.startsWith('blob:') && !url.startsWith('data:')) {
        imageUrls.push(url);
      }
    }
    
    if (imageUrls.length === 0) return html;
    
    await initImageCache();
    
    const urlMap = new Map<string, string>();
    const imagePromises = imageUrls.map(async (originalUrl) => {
      try {
        const cachedUrl = await getCachedImage(originalUrl);
        if (cachedUrl !== originalUrl) {
          urlMap.set(originalUrl, cachedUrl);
        }
      } catch (error) {
        console.error(`Failed to cache image ${originalUrl}:`, error);
      }
    });
    
    await Promise.all(imagePromises);
    
    let updatedHtml = html;
    urlMap.forEach((cachedUrl, originalUrl) => {
      const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      updatedHtml = updatedHtml.replace(new RegExp(escapedUrl, 'g'), cachedUrl);
    });
    
    return updatedHtml;
  }, [initImageCache, getCachedImage]);

  // 预渲染卡片内容
  const preloadCardContent = useCallback(async (card: Card) => {
    const cardIdStr = String(card.docId);
    
    // 如果已经在缓存中，跳过
    if (cardContentCacheRef.current[cardIdStr]) {
      return;
    }
    
    if (!card.content) {
      cardContentCacheRef.current[cardIdStr] = '<p style="color: #888;">暂无内容</p>';
      return;
    }
    
    try {
      const response = await fetch('/markdown', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: card.content || '',
          inline: false,
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to render markdown');
      }
      
      let html = await response.text();
      
      // 预加载并缓存图片
      html = await preloadAndCacheImages(html);
      
      // 等待图片加载完成
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      const images = tempDiv.querySelectorAll('img');
      
      if (images.length > 0) {
        const imagePromises = Array.from(images).map(img => {
          return new Promise<void>((resolve) => {
            if ((img as HTMLImageElement).complete) {
              resolve();
            } else {
              img.onload = () => resolve();
              img.onerror = () => resolve();
              setTimeout(() => resolve(), 10000);
            }
          });
        });
        
        await Promise.all(imagePromises);
      }
      
      cardContentCacheRef.current[cardIdStr] = html;
      // cachedCardsRef.current.add(cardIdStr);
      // setCachedCount(cachedCardsRef.current.size);
    } catch (error) {
      console.error(`Failed to preload card ${card.docId}:`, error);
      cardContentCacheRef.current[cardIdStr] = '<p style="color: #f44336;">加载内容失败</p>';
    }
  }, [preloadAndCacheImages]);

  // 将preloadCardContent存储到ref中
  // useEffect(() => {
  //   preloadCardContentRef.current = preloadCardContent;
  // }, [preloadCardContent]);

  // 初始化时自动开始缓存
  // useEffect(() => {
  //   const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
  //   if (Object.keys(nodeCardsMap).length > 0) {
  //     // 延迟一下，确保组件完全加载
  //     setTimeout(() => {
  //       startCaching();
  //     }, 1000);
  //   }
  // }, [mindMap.mmid, startCaching]);

  // 渲染card内容（优先使用缓存）
  useEffect(() => {
    if (!selectedCard) return;
    
    const contentDiv = document.getElementById('card-content-outline');
    if (!contentDiv) return;
    
    const cardIdStr = String(selectedCard.docId);
    
    // 检查缓存
    if (cardContentCacheRef.current[cardIdStr]) {
      // 直接使用缓存的内容
      contentDiv.innerHTML = cardContentCacheRef.current[cardIdStr];
    } else if (selectedCard.content) {
      // 缓存中没有，显示加载状态并渲染
      contentDiv.innerHTML = '<p style="color: #999; text-align: center;">加载中...</p>';
      
      fetch('/markdown', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: selectedCard.content || '',
          inline: false,
        }),
      })
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to render markdown');
        }
        return response.text();
      })
      .then(async html => {
        // 预加载并缓存图片
        html = await preloadAndCacheImages(html);
        // 缓存渲染结果
        cardContentCacheRef.current[cardIdStr] = html;
        contentDiv.innerHTML = html;
      })
      .catch(error => {
        console.error('Failed to render markdown:', error);
        const errorHtml = '<p style="color: #f44336;">加载内容失败</p>';
        cardContentCacheRef.current[cardIdStr] = errorHtml;
        contentDiv.innerHTML = errorHtml;
      });
    } else {
      const emptyHtml = '<p style="color: #888;">暂无内容</p>';
      cardContentCacheRef.current[cardIdStr] = emptyHtml;
      contentDiv.innerHTML = emptyHtml;
    }
  }, [selectedCard, preloadAndCacheImages]);


  // 监听数据更新
  useEffect(() => {
    let ws: any = null;
    const domainId = (window as any).UiContext?.domainId || 'system';
    const wsUrl = `/d/${domainId}/mindmap/${docId}/ws`;

    // 连接 WebSocket 的函数
    const connectWebSocket = () => {
      import('../components/socket').then(({ default: WebSocket }) => {
        ws = new WebSocket(wsUrl, false, true);

        ws.onopen = () => {
          console.log('[MindMap Outline] WebSocket connected');
        };

        ws.onmessage = (_: any, data: string) => {
          try {
            const msg = JSON.parse(data);
            console.log('[MindMap Outline] WebSocket message:', msg);

            if (msg.type === 'init' || msg.type === 'update') {
              // 重新加载数据
              const domainId = (window as any).UiContext?.domainId || 'system';
              request.get(getMindMapUrl('/data', docId)).then((responseData) => {
                if (responseData?.mindMap) {
                  setMindMap(responseData.mindMap);
                } else {
                  setMindMap(responseData);
                }
                if ((window as any).UiContext) {
                  const updatedMap = responseData?.nodeCardsMap
                    || responseData?.mindMap?.nodeCardsMap
                    || {};
                  (window as any).UiContext.nodeCardsMap = updatedMap;
                  
                  // 预加载新卡片内容
                  const allCards: Card[] = [];
                  Object.values(updatedMap).forEach((cards: Card[]) => {
                    if (Array.isArray(cards)) {
                      allCards.push(...cards);
                    }
                  });
                  
                  // 清除缓存并重新开始缓存
                  cardContentCacheRef.current = {};
                  cachedCardsRef.current.clear();
                  setCachedCount(0);
                  cachingTaskRef.current.cancelled = false;
                  setIsCachingPaused(false);
                  startCaching();
                }
              }).catch((error) => {
                console.error('Failed to reload data:', error);
              });
            }
          } catch (error) {
            console.error('[MindMap Outline] Failed to parse WebSocket message:', error);
          }
        };

        ws.onclose = () => {
          console.log('[MindMap Outline] WebSocket closed');
          ws = null;
        };

        ws.onerror = (error: any) => {
          console.error('[MindMap Outline] WebSocket error:', error);
        };
      }).catch((error) => {
        console.error('[MindMap Outline] Failed to load WebSocket:', error);
      });
    };

    // 初始连接
    connectWebSocket();

    return () => {
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          // ignore
        }
      }
    };
  }, [docId, selectedCard]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%', backgroundColor: '#fff' }}>
      {/* 工具栏 */}
      <div style={{
        padding: '10px 20px',
        background: '#f5f5f5',
        borderBottom: '1px solid #ddd',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <a
          href={(() => {
            const domainId = (window as any).UiContext?.domainId || 'system';
            const branch = mindMap.currentBranch || 'main';
            return `/d/${domainId}/mindmap/${docId}/branch/${branch}`;
          })()}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            color: '#333',
            textDecoration: 'none',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          返回导图模式
        </a>
        <a
          href={(() => {
            const domainId = (window as any).UiContext?.domainId || 'system';
            const branch = mindMap.currentBranch || 'main';
            return `/d/${domainId}/mindmap/${docId}/branch/${branch}/editor`;
          })()}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            color: '#333',
            textDecoration: 'none',
            cursor: 'pointer',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
          title="进入编辑器模式"
        >
          <span>.</span>
          <span>编辑器</span>
        </a>
        {/* <button
          onClick={() => setShowCachePanel(!showCachePanel)}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: showCachePanel ? '#1976d2' : '#fff',
            color: showCachePanel ? '#fff' : '#333',
            cursor: 'pointer',
            fontWeight: 'bold',
            marginLeft: '10px',
          }}
          title="缓存管理"
        >
          💾 缓存
        </button> */}
        <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
          {mindMap.title} - 文件模式
        </div>
      </div>

      {/* 主内容区域 */}
      <div style={{ display: 'flex', flex: 1, width: '100%', position: 'relative', backgroundColor: '#fff' }}>
        {/* 缓存管理侧边栏 */}
        {/* {showCachePanel && (
          <div style={{
            width: '280px',
            borderRight: '1px solid #e0e0e0',
            backgroundColor: '#fff',
            overflow: 'auto',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{
              padding: '16px',
              borderBottom: '1px solid #e0e0e0',
              backgroundColor: '#f6f8fa',
            }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#333' }}>
                💾 缓存管理
              </h3>
            </div>
            <div style={{ padding: '16px', flex: 1 }}>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>缓存统计</div>
                <div style={{ fontSize: '13px', color: '#333', marginBottom: '4px' }}>
                  已缓存: {cachedCardsRef.current.size} 个卡片
                </div>
                <div style={{ fontSize: '13px', color: '#333' }}>
                  缓存大小: {formatCacheSize(getCacheSize())}
                </div>
              </div>

              {cachingProgress && (
                <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f6f8fa', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>缓存进度</div>
                  <div style={{ 
                    width: '100%', 
                    height: '8px', 
                    backgroundColor: '#e0e0e0', 
                    borderRadius: '4px',
                    overflow: 'hidden',
                    marginBottom: '8px',
                  }}>
                    <div style={{
                      width: `${(cachingProgress.current / cachingProgress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#4caf50',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', textAlign: 'center' }}>
                    {cachingProgress.current} / {cachingProgress.total}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {isCachingPaused ? (
                  <button
                    onClick={startCaching}
                    style={{
                      padding: '8px 16px',
                      border: 'none',
                      borderRadius: '4px',
                      background: '#4caf50',
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '13px',
                    }}
                  >
                    ▶ 开始缓存
                  </button>
                ) : (
                  <button
                    onClick={pauseCaching}
                    style={{
                      padding: '8px 16px',
                      border: 'none',
                      borderRadius: '4px',
                      background: '#ff9800',
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '13px',
                    }}
                  >
                    ⏸ 暂停缓存
                  </button>
                )}
                <button
                  onClick={clearCache}
                  style={{
                    padding: '8px 16px',
                    border: 'none',
                    borderRadius: '4px',
                    background: '#f44336',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '13px',
                  }}
                >
                  🗑 清空缓存
                </button>
              </div>
            </div>
          </div>
        )} */}

        {/* 左侧文件树侧边栏 */}
        <div style={{
          width: '300px',
          borderRight: '1px solid #e0e0e0',
          backgroundColor: '#f6f8fa',
          overflow: 'auto',
          flexShrink: 0,
        }}>
          <div style={{ padding: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: '600', color: '#666', marginBottom: '8px', padding: '0 8px' }}>
              文件结构
            </div>
            {fileTree.map((file) => {
              const isSelected = file.type === 'card' && selectedCard && file.cardId === selectedCard.docId;
              return (
                <div
                  key={file.id}
                  onClick={() => {
                    if (file.type === 'card') {
                      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                      const nodeCards = nodeCardsMap[file.nodeId || ''] || [];
                      const card = nodeCards.find((c: Card) => c.docId === file.cardId);
                      if (card) {
                        handleSelectCard(card);
                      }
                    } else {
                      toggleNodeExpanded(file.nodeId || '');
                    }
                  }}
                  style={{
                    padding: `4px ${8 + file.level * 16}px`,
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: isSelected ? '#1976d2' : '#333',
                    backgroundColor: isSelected ? '#e3f2fd' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'background-color 0.15s ease, color 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    // 如果已选中，保持选中背景色和文字颜色；否则显示悬停背景色
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = '#f0f0f0';
                      e.currentTarget.style.color = '#333';
                    }
                  }}
                  onMouseLeave={(e) => {
                    // 恢复正确的背景色和文字颜色：如果选中则保持选中样式，否则恢复默认
                    e.currentTarget.style.backgroundColor = isSelected ? '#e3f2fd' : 'transparent';
                    e.currentTarget.style.color = isSelected ? '#1976d2' : '#333';
                  }}
                >
                  {file.type === 'node' ? (
                    <>
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleNodeExpanded(file.nodeId || '');
                        }}
                        style={{
                          width: '16px',
                          height: '16px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          flexShrink: 0,
                          fontSize: '10px',
                          color: '#666',
                        }}
                      >
                        {expandedNodes.has(file.nodeId || '') ? '▼' : '▶'}
                      </span>
                      <span style={{ fontSize: '16px', flexShrink: 0 }}>📁</span>
                    </>
                  ) : (
                    <span style={{ fontSize: '16px', flexShrink: 0 }}>📄</span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右侧card内容显示区域 */}
        {selectedCard ? (
          <div style={{
            flex: 1,
            borderLeft: '1px solid #e0e0e0',
            backgroundColor: '#fff',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{
              padding: '16px',
              borderBottom: '1px solid #e0e0e0',
              backgroundColor: '#f6f8fa',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: '#333' }}>
                  {selectedCard.title || '未命名卡片'}
                </h3>
                {/* {cachingProgress && cachingProgress.nodeId === selectedCard.nodeId && (
                  <div style={{ fontSize: '12px', color: '#666', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>缓存中...</span>
                    <div style={{ 
                      width: '100px', 
                      height: '6px', 
                      backgroundColor: '#e0e0e0', 
                      borderRadius: '3px',
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${(cachingProgress.current / cachingProgress.total) * 100}%`,
                        height: '100%',
                        backgroundColor: '#4caf50',
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                    <span>{cachingProgress.current}/{cachingProgress.total}</span>
                  </div>
                )} */}
              </div>
            </div>
            <div style={{
              flex: 1,
              padding: '16px',
              overflow: 'auto',
            }}>
              <div
                id="card-content-outline"
                style={{
                  fontSize: '14px',
                  lineHeight: '1.6',
                  color: '#333',
                }}
                dangerouslySetInnerHTML={{ __html: '<p style="color: #999;">加载中...</p>' }}
              />
            </div>
          </div>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#999',
            fontSize: '14px',
          }}>
            请从左侧选择一个卡片
          </div>
        )}
      </div>
    </div>
  );
}

// 辅助函数：获取带 domainId 的 mindmap URL
const getMindMapUrl = (path: string, docId: string): string => {
  const domainId = (window as any).UiContext?.domainId || 'system';
  return `/d/${domainId}/mindmap/${docId}${path}`;
};

const page = new NamedPage('mindmap_outline', async () => {
  try {
    const $container = $('#mindmap-outline-editor');
    if (!$container.length) {
      return;
    }

    const docId = $container.data('doc-id') || $container.attr('data-doc-id');
    if (!docId) {
      Notification.error('思维导图ID未找到');
      return;
    }

    // 加载思维导图数据
    let initialData: MindMapDoc;
    try {
      const response = await request.get(getMindMapUrl('/data', docId));
      initialData = response;
    } catch (error: any) {
      Notification.error('加载思维导图失败: ' + (error.message || '未知错误'));
      return;
    }

    ReactDOM.render(
      <MindMapOutlineEditor docId={docId} initialData={initialData} />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize mindmap outline editor:', error);
    Notification.error('初始化文件模式编辑器失败: ' + (error.message || '未知错误'));
  }
});

export default page;


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
  order?: number; // 节点顺序
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

// ReactFlow Node和Edge类型（用于OutlineView）
interface ReactFlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: {
    label?: string;
    originalNode: MindMapNode;
    [key: string]: any;
  };
}

interface ReactFlowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: {
    originalEdge: MindMapEdge;
    [key: string]: any;
  };
}

const OutlineView = ({
  nodes,
  edges,
  onToggleExpand,
  onNodeClick,
  selectedNodeId,
  rootNodeId,
}: {
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
  onToggleExpand: (nodeId: string) => void;
  onNodeClick: (nodeId: string) => void;
  selectedNodeId: string | null;
  rootNodeId?: string | null;
}) => {
  // 大纲节点的展开状态（不记录状态，默认展开）
  const [expandedNodesOutline, setExpandedNodesOutline] = useState<Set<string>>(() => {
    // 默认所有节点都展开
    const allExpanded = new Set<string>();
    nodes.forEach(node => {
      allExpanded.add(node.id);
    });
    return allExpanded;
  });
  
  // 内部的toggleExpand函数，管理大纲的展开状态（不持久化，仅内存中，完全独立于文件结构）
  const handleToggleExpand = useCallback((nodeId: string) => {
    setExpandedNodesOutline(prev => {
      // 创建新的 Set 实例以确保 React 能检测到变化
      const newSet = new Set(prev);
      const wasExpanded = newSet.has(nodeId);
      if (wasExpanded) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      // 始终返回新的 Set，确保引用变化
      return new Set(newSet);
    });
    // 不调用外部的onToggleExpand，保持大纲状态完全独立
  }, []);
  
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

  // 当节点变化时，更新展开状态（大纲默认展开所有节点，不记录状态）
  useEffect(() => {
    setExpandedNodesOutline(prev => {
      const newSet = new Set(prev);
      let changed = false;
      nodes.forEach(node => {
        if (!newSet.has(node.id)) {
          newSet.add(node.id);
          changed = true;
        }
      });
      return changed ? newSet : prev;
    });
  }, [nodes]);

  // 当节点变化时，更新卡片展开状态
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
    const nodeMap = new Map<string, { node: ReactFlowNode; children: string[] }>();
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

    // 为每个节点的子节点按照order排序（保持和原始mindMap中的顺序一致）
    nodeMap.forEach((nodeData) => {
      nodeData.children.sort((a, b) => {
        const nodeA = nodes.find(n => n.id === a);
        const nodeB = nodes.find(n => n.id === b);
        const originalNodeA = nodeA?.data.originalNode as MindMapNode | undefined;
        const originalNodeB = nodeB?.data.originalNode as MindMapNode | undefined;
        const orderA = originalNodeA?.order || 0;
        const orderB = originalNodeB?.order || 0;
        return orderA - orderB;
      });
    });

    // 找到根节点（没有父节点的节点）
    // 如果指定了rootNodeId，优先使用它作为根节点
    if (rootNodeId && nodeMap.has(rootNodeId)) {
      rootNodes.push(rootNodeId);
    } else {
    nodes.forEach((node) => {
      const hasParent = edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });
    }

    return { nodeMap, rootNodes };
  }, [nodes, edges, rootNodeId]);

  // 获取根节点信息（用于显示标题）
  const rootNodeInfo = useMemo(() => {
    // 如果指定了rootNodeId，使用它作为根节点
    const targetRootNodeId = rootNodeId || (buildTree.rootNodes.length > 0 ? buildTree.rootNodes[0] : null);
    if (!targetRootNodeId) return null;
    
    const rootNodeData = buildTree.nodeMap.get(targetRootNodeId);
    if (!rootNodeData) return null;
    const originalNode = rootNodeData.node.data.originalNode as MindMapNode;
    return {
      id: targetRootNodeId,
      text: originalNode?.text || '未命名节点',
      children: rootNodeData.children,
    };
  }, [buildTree, rootNodeId]);

  // 获取节点的所有可见子节点（递归）
  const getAllVisibleChildren = useCallback((nodeId: string): string[] => {
    const nodeData = buildTree.nodeMap.get(nodeId);
    if (!nodeData) return [];
    
    const { node, children } = nodeData;
    // 使用大纲的独立展开状态
    const expanded = expandedNodesOutline.has(nodeId);
    
    if (!expanded || children.length === 0) return [];
    
    const visibleChildren: string[] = [];
    children.forEach((childId) => {
      visibleChildren.push(childId);
      visibleChildren.push(...getAllVisibleChildren(childId));
    });
    
    return visibleChildren;
  }, [buildTree, expandedNodesOutline]);

  // 获取节点的卡片列表
  const getNodeCards = useCallback((nodeId: string): Card[] => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cards = nodeCardsMap[nodeId] || [];
    // 按order排序，保持和原始mindMap中的顺序一致
    return [...cards].sort((a, b) => {
      const orderA = (a.order as number) || 0;
      const orderB = (b.order as number) || 0;
      return orderA - orderB;
    });
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
      // 大纲默认折叠（使用独立的展开状态，不与文件结构同步）
      const expanded = expandedNodesOutline.has(nodeId);
      const hasChildren = children.length > 0;
      const isSelected = selectedNodeId === nodeId;
      
      // 获取节点的卡片列表（已按order排序）
      const cards = getNodeCards(nodeId);
      
      // 获取子节点（按order排序）
      const childNodes = children.map(childId => {
        const childNodeData = buildTree.nodeMap.get(childId);
        if (!childNodeData) return null;
        const childOriginalNode = childNodeData.node.data.originalNode as MindMapNode;
        return {
          id: childId,
          order: childOriginalNode?.order || 0,
        };
      }).filter(Boolean) as Array<{ id: string; order: number }>;
      
      // 合并节点和卡片，按照order混合排序
      const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
        ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: null })),
        ...cards.map(c => ({ 
          type: 'card' as const, 
          id: c.docId || String(c.cid || ''), 
          order: (c.order as number) || 0, 
          data: c 
        })),
      ];
      
      // 按order排序
      allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));

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
                {hasChildren || cards.length > 0 ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleExpand(nodeId);
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
              </div>
            </div>
                </div>
                
          {/* 子节点和卡片 - 按order混合排序，平铺显示 */}
          {expanded && allChildren.length > 0 && (
            <div style={{ position: 'relative', marginLeft: `${level * 24}px` }}>
              {/* 侧边垂直范围线 */}
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
                {allChildren.map((item, index) => {
                  if (item.type === 'card') {
                    // 渲染卡片（平铺显示，无折叠按钮）
                    const card = item.data as Card;
                    return (
                      <div
                        key={`card-${card.docId || card.cid}`}
                        style={{
                          marginLeft: '24px',
                          marginTop: '4px',
                          marginBottom: '4px',
                        }}
                      >
                        <div
                        onClick={(e) => {
                          e.stopPropagation();
                      window.open(getCardUrl(card, nodeId), '_blank');
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
          </div>
                    );
                  } else {
                    // 渲染子节点
                    const childId = item.id;
                    const childNodeData = buildTree.nodeMap.get(childId);
                    if (!childNodeData) return null;
                    const isLastChild = index === allChildren.length - 1;
                    const childHasSiblings = allChildren.length > 1;
                  return renderNodeTree(childId, level + 1, isLastChild, childHasSiblings);
                  }
                })}
              </div>
            </div>
          )}
        </div>
      );
    },
    [buildTree, selectedNodeId, handleToggleExpand, onNodeClick, getNodeCards, getCardUrl, cardsExpanded, toggleCardsExpanded, expandedNodesOutline]
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
          
          {/* 从根节点的子节点和卡片开始展示，按order混合排序 */}
          {(() => {
            const rootCards = getNodeCards(rootNodeInfo.id);
            const rootChildNodes = rootNodeInfo.children.map(childId => {
              const childNodeData = buildTree.nodeMap.get(childId);
              if (!childNodeData) return null;
              const childOriginalNode = childNodeData.node.data.originalNode as MindMapNode;
              return {
                id: childId,
                order: childOriginalNode?.order || 0,
              };
            }).filter(Boolean) as Array<{ id: string; order: number }>;
            
            // 合并根节点的子节点和卡片，按照order混合排序
            const rootAllChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
              ...rootChildNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: null })),
              ...rootCards.map(c => ({ 
                type: 'card' as const, 
                id: c.docId || String(c.cid || ''), 
                order: (c.order as number) || 0, 
                data: c 
              })),
            ];
            
            // 按order排序
            rootAllChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
            
            if (rootAllChildren.length === 0) {
              return (
            <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '14px' }}>
                  暂无内容
            </div>
              );
            }
            
            return (
            <div style={{ paddingLeft: '4px' }}>
                {rootAllChildren.map((item, index) => {
                  if (item.type === 'card') {
                    // 渲染根节点的卡片（平铺显示）
                    const card = item.data as Card;
                    return (
                      <div
                        key={`card-${card.docId || card.cid}`}
                        style={{
                          marginLeft: '24px',
                          marginTop: '4px',
                          marginBottom: '4px',
                        }}
                      >
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(getCardUrl(card, rootNodeInfo.id), '_blank');
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
                      </div>
                    );
                  } else {
                    // 渲染根节点的子节点
                    const childId = item.id;
                    const isLastChild = index === rootAllChildren.length - 1;
                    const childHasSiblings = rootAllChildren.length > 1;
                    return renderNodeTree(childId, 0, isLastChild, childHasSiblings);
                  }
              })}
            </div>
            );
          })()}
        </>
      )}
    </div>
  );
};

function MindMapOutlineEditor({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  const [mindMap, setMindMap] = useState<MindMapDoc>(initialData);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // 标记是否正在手动设置选择（避免useEffect干扰）
  const isManualSelectionRef = useRef(false);
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

  // 卡片内容缓存（内存缓存，用于快速访问）
  const cardContentCacheRef = useRef<Record<string, string>>({});
  // 图片缓存（使用 Cache API）
  const imageCacheRef = useRef<Cache | null>(null);
  // 缓存状态：记录哪些card已经被缓存
  const cachedCardsRef = useRef<Set<string>>(new Set());
  // 缓存进度
  const [cachingProgress, setCachingProgress] = useState<{ current: number; total: number; currentCard?: string } | null>(null);
  // 缓存状态检查结果
  const [cacheStatus, setCacheStatus] = useState<{
    outdated: Array<{ cardId: string; title: string; cachedUpdateAt: string; currentUpdateAt: string }>;
    total: number;
  } | null>(null);
  const [isCheckingCache, setIsCheckingCache] = useState(false);
  const [isUpdatingCache, setIsUpdatingCache] = useState(false);
  // Explorer 模式：'tree' | 'cache'
  const [explorerMode, setExplorerMode] = useState<'tree' | 'cache'>('tree');
  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem } | null>(null);
  // 缓存计数
  // const [cachedCount, setCachedCount] = useState(0);
  // 卡片缓存进度：记录正在缓存的进度
  // const [cachingProgress, setCachingProgress] = useState<{ current: number; total: number } | null>(null);
  // 图片缓存进度：记录正在缓存的图片进度
  // const [imageCachingProgress, setImageCachingProgress] = useState<{ current: number; total: number } | null>(null);
  // 缓存控制：是否暂停缓存
  // const [isCachingPaused, setIsCachingPaused] = useState(false);
  // 缓存管理侧边栏是否显示
  // const [showCachePanel, setShowCachePanel] = useState(false);
  // 缓存任务是否正在运行
  // const cachingTaskRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  // WebSocket 连接 ref（用于缓存请求）
  const wsRef = useRef<any>(null);
  // WebSocket 请求的 Promise Map（用于处理响应）
  const wsRequestMapRef = useRef<Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>>(new Map());

  // 从 localStorage 加载缓存（检查版本）
  useEffect(() => {
    try {
      const keys = Object.keys(localStorage);
      const cachePrefix = 'mindmap-outline-card-';
      let loadedCount = 0;
      let invalidatedCount = 0;
      
      // 获取最新的 card 数据用于版本检查
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const allCards: Card[] = [];
      Object.values(nodeCardsMap).forEach((cards: Card[]) => {
        if (Array.isArray(cards)) {
          allCards.push(...cards);
        }
      });
      const cardMap = new Map<string, Card>();
      allCards.forEach(card => {
        cardMap.set(String(card.docId), card);
      });
      
      keys.forEach(key => {
        if (key.startsWith(cachePrefix)) {
          const cardId = key.replace(cachePrefix, '');
          const cachedDataStr = localStorage.getItem(key);
          if (cachedDataStr) {
            try {
              // 尝试解析新格式（包含updateAt）
              const cachedData = JSON.parse(cachedDataStr);
              if (cachedData.html && cachedData.updateAt) {
                // 检查版本
                const currentCard = cardMap.get(cardId);
                if (currentCard && currentCard.updateAt && currentCard.updateAt !== cachedData.updateAt) {
                  // 版本不匹配，删除缓存
                  localStorage.removeItem(key);
                  invalidatedCount++;
                  return;
                }
                cardContentCacheRef.current[cardId] = cachedData.html;
                cachedCardsRef.current.add(cardId);
                loadedCount++;
              } else {
                // 旧格式（纯HTML），直接使用但标记为需要更新
                cardContentCacheRef.current[cardId] = cachedData.html || cachedDataStr;
                cachedCardsRef.current.add(cardId);
                loadedCount++;
              }
            } catch (e) {
              // 旧格式（纯HTML字符串），直接使用但标记为需要更新
              cardContentCacheRef.current[cardId] = cachedDataStr;
              cachedCardsRef.current.add(cardId);
              loadedCount++;
            }
          }
        }
      });
      
      if (loadedCount > 0) {
        console.log(`[MindMap Outline] 从 localStorage 加载了 ${loadedCount} 个 card 缓存`);
      }
      if (invalidatedCount > 0) {
        console.log(`[MindMap Outline] 清除了 ${invalidatedCount} 个过期缓存`);
      }
    } catch (error) {
      console.error('Failed to load cache from localStorage:', error);
    }
    
    // 初始化图片缓存（在函数定义之后调用）
    if ('caches' in window && !imageCacheRef.current) {
      caches.open('mindmap-outline-images-v1').then(cache => {
        imageCacheRef.current = cache;
      }).catch(error => {
        console.error('Failed to init image cache:', error);
      });
    }
  }, []);

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

  // 检查缓存状态（类似 git status）
  const checkCacheStatus = useCallback(async () => {
    setIsCheckingCache(true);
    try {
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const allCards: Card[] = [];
      Object.values(nodeCardsMap).forEach((cards: Card[]) => {
        if (Array.isArray(cards)) {
          allCards.push(...cards);
        }
      });
      
      const outdated: Array<{ cardId: string; title: string; cachedUpdateAt: string; currentUpdateAt: string }> = [];
      const cachedCardIds = new Set<string>();
      
      // 方法1: 检查所有卡片，看它们是否有缓存需要更新
      for (const card of allCards) {
        const cardIdStr = String(card.docId);
        try {
          const cacheKey = `mindmap-outline-card-${cardIdStr}`;
          const cachedDataStr = localStorage.getItem(cacheKey);
          if (cachedDataStr) {
            // 有缓存，标记为已缓存
            cachedCardIds.add(cardIdStr);
            // 同步到 cachedCardsRef
            if (!cachedCardsRef.current.has(cardIdStr)) {
              cachedCardsRef.current.add(cardIdStr);
            }
            
            try {
              const cachedData = JSON.parse(cachedDataStr);
              // 检查是否有 html 字段（新格式）
              if (cachedData.html) {
                // 新格式，检查 updateAt
                if (cachedData.updateAt && card.updateAt && cachedData.updateAt !== card.updateAt) {
                  outdated.push({
                    cardId: cardIdStr,
                    title: card.title || '未命名卡片',
                    cachedUpdateAt: cachedData.updateAt,
                    currentUpdateAt: card.updateAt,
                  });
                }
                // 如果 updateAt 匹配，说明缓存是最新的，不需要更新
              } else {
                // 旧格式（纯HTML字符串），标记为需要更新
                outdated.push({
                  cardId: cardIdStr,
                  title: card.title || '未命名卡片',
                  cachedUpdateAt: '未知',
                  currentUpdateAt: card.updateAt || '未知',
                });
              }
            } catch (e) {
              // 解析失败，可能是旧格式（纯HTML字符串），标记为需要更新
              outdated.push({
                cardId: cardIdStr,
                title: card.title || '未命名卡片',
                cachedUpdateAt: '未知',
                currentUpdateAt: card.updateAt || '未知',
              });
            }
          }
        } catch (error) {
          console.error(`Failed to check cache for card ${cardIdStr}:`, error);
        }
      }
      
      // 方法2: 检查 localStorage 中所有 mindmap-outline-card-* 的键，清理不存在的卡片缓存
      try {
        const allKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('mindmap-outline-card-')) {
            allKeys.push(key);
          }
        }
        
        for (const key of allKeys) {
          const cardIdStr = key.replace('mindmap-outline-card-', '');
          const card = allCards.find(c => String(c.docId) === cardIdStr);
          if (!card) {
            // 如果 card 不存在于当前数据中，从缓存中移除
            cachedCardsRef.current.delete(cardIdStr);
            delete cardContentCacheRef.current[cardIdStr];
            try {
              localStorage.removeItem(key);
            } catch (error) {
              console.error(`Failed to remove cache for ${cardIdStr}:`, error);
            }
          }
        }
      } catch (error) {
        console.error('Failed to clean up old cache entries:', error);
      }
      
      // 同步 cachedCardsRef，移除不在 localStorage 中的标记
      cachedCardsRef.current.forEach(cardIdStr => {
        const cacheKey = `mindmap-outline-card-${cardIdStr}`;
        if (!localStorage.getItem(cacheKey)) {
          cachedCardsRef.current.delete(cardIdStr);
          delete cardContentCacheRef.current[cardIdStr];
        }
      });
      
      setCacheStatus({
        outdated,
        total: cachedCardIds.size,
      });
    } catch (error) {
      console.error('Failed to check cache status:', error);
    } finally {
      setIsCheckingCache(false);
    }
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
    
    // 当 mindMap 更新时，自动检查缓存状态（延迟一下，确保 nodeCardsMap 已更新）
    const timer = setTimeout(() => {
      if (cachedCardsRef.current.size > 0) {
        checkCacheStatus();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [mindMap, checkCacheStatus]);

  // 递归检查 node 及其所有子节点和子卡片是否都已缓存
  const checkNodeCachedRef = useRef<((nodeId: string) => boolean) | null>(null);
  const checkNodeCached = useCallback((nodeId: string): boolean => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || []).filter((card: Card) => {
      return !card.nodeId || card.nodeId === nodeId;
    });
    
    // 检查该 node 下的所有 card 是否都已缓存
    const allCardsCached = nodeCards.length === 0 || nodeCards.every((card: Card) => {
      const cardIdStr = String(card.docId);
      return cachedCardsRef.current.has(cardIdStr);
    });
    
    if (!allCardsCached) {
      return false;
    }
    
    // 检查该 node 下的所有子 node 是否都已缓存（递归）
    const nodeData = mindMap.nodes.find(n => n.id === nodeId);
    if (!nodeData) {
      return allCardsCached;
    }
    
    // 获取所有子节点
    const childNodeIds = mindMap.edges
      .filter(edge => edge.source === nodeId)
      .map(edge => edge.target);
    
    if (childNodeIds.length === 0) {
      return allCardsCached;
    }
    
    // 递归检查每个子节点（使用 ref 中的函数避免循环依赖）
    const checkFn = checkNodeCachedRef.current || checkNodeCached;
    const allChildNodesCached = childNodeIds.every(childNodeId => {
      return checkFn(childNodeId);
    });
    
    return allCardsCached && allChildNodesCached;
  }, [mindMap]);
  
  // 将函数存储到 ref 中，用于递归调用
  useEffect(() => {
    checkNodeCachedRef.current = checkNodeCached;
  }, [checkNodeCached]);

  // 构建文件树（优化性能：使用 nodeMap 而不是 find，优化 expandedNodes 依赖）
  const expandedNodesArray = useMemo(() => Array.from(expandedNodes), [expandedNodes]);
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

    // 找到根节点（优化：使用 Set 来快速查找）
    const hasParentSet = new Set(mindMap.edges.map(e => e.target));
    mindMap.nodes.forEach((node) => {
      if (!hasParentSet.has(node.id)) {
        rootNodes.push(node.id);
      }
    });

    // 获取最新的 nodeCardsMap
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const expandedSet = new Set(expandedNodesArray);

    // 递归构建文件树
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node, children } = nodeData;
      const isExpanded = expandedSet.has(nodeId);

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

      // 如果节点展开，显示其卡片和子节点（按order混合排序）
      if (isExpanded) {
        // 获取该节点的卡片（按 order 排序）
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        // 获取子节点（按 order 排序，优化：使用 nodeMap 而不是 find）
        const childNodes = children
          .map(childId => {
            const childNodeData = nodeMap.get(childId);
            if (!childNodeData) return null;
            const childNode = childNodeData.node;
            return { id: childId, node: childNode, order: childNode.order || 0 };
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: MindMapNode; order: number }>;

        // 合并node和card，按照order混合排序（直接使用editor的逻辑）
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node })),
          ...nodeCards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c })),
        ];
        
        // 按order排序
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        // 按照排序后的顺序添加
        allChildren.forEach(item => {
          if (item.type === 'card') {
            const card = item.data as Card;
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
          } else {
            // 递归处理子节点
            buildTree(item.id, level + 1, nodeId);
      }
        });
      }
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });

    return items;
  }, [mindMap.nodes, mindMap.edges, expandedNodesArray]);

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

  // 构建选中node及其子节点的nodes和edges（用于OutlineView）
  const getNodeSubgraph = useCallback((nodeId: string): { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] } => {
    const nodeMap = new Map<string, MindMapNode>();
    const edgeMap = new Map<string, MindMapEdge>();
    const visitedNodes = new Set<string>();

    // 递归收集节点及其所有子节点（包括子节点的子节点）
    const collectNodes = (id: string) => {
      if (visitedNodes.has(id)) return;
      visitedNodes.add(id);

      const node = mindMap.nodes.find(n => n.id === id);
    if (!node) return;
    
      nodeMap.set(id, node);

      // 收集所有子节点（递归）
      const childEdges = mindMap.edges.filter(e => e.source === id);
      childEdges.forEach(edge => {
        edgeMap.set(edge.id, edge);
        // 递归收集子节点的子节点
        collectNodes(edge.target);
    });
    };

    // 从被点击的node开始收集
    collectNodes(nodeId);

    // 转换为ReactFlow格式
    const reactFlowNodes: ReactFlowNode[] = Array.from(nodeMap.values()).map(node => ({
        id: node.id,
      type: 'default',
      position: { x: node.x || 0, y: node.y || 0 },
        data: {
        label: node.text || '未命名节点',
          originalNode: node,
      },
    }));

    // 只保留以收集到的节点为source的edges（确保被点击的node是根节点）
    const reactFlowEdges: ReactFlowEdge[] = Array.from(edgeMap.values())
      .filter(edge => nodeMap.has(edge.source) && nodeMap.has(edge.target))
      .map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
        type: 'default',
        data: {
          originalEdge: edge,
        },
      }));

    return { nodes: reactFlowNodes, edges: reactFlowEdges };
  }, [mindMap]);

  // 处理node展开/折叠（用于OutlineView）
  const handleNodeToggleExpand = useCallback((nodeId: string) => {
    // 更新mindMap中对应node的expanded状态
    setMindMap(prev => ({
      ...prev,
      nodes: prev.nodes.map(node =>
        node.id === nodeId
          ? { ...node, expanded: node.expanded === false ? true : false }
          : node
      ),
    }));
  }, []);

  // 处理node点击（用于OutlineView）
  const handleNodeClick = useCallback((nodeId: string) => {
    // 可以在这里添加额外的逻辑，比如导航到该node
    console.log('Node clicked:', nodeId);
  }, []);

  // 初始化图片缓存
  const initImageCache = useCallback(async () => {
    if ('caches' in window && !imageCacheRef.current) {
      try {
        imageCacheRef.current = await caches.open('mindmap-outline-images-v1');
      } catch (error) {
        console.error('Failed to open image cache:', error);
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

  // 预渲染卡片内容（包括缓存到 localStorage）
  const preloadCardContent = useCallback(async (card: Card) => {
    const cardIdStr = String(card.docId);
    
    if (!card.content) {
      const emptyHtml = '<p style="color: #888;">暂无内容</p>';
      cardContentCacheRef.current[cardIdStr] = emptyHtml;
      cachedCardsRef.current.add(cardIdStr);
      try {
        const cacheKey = `mindmap-outline-card-${cardIdStr}`;
        const cacheData = {
          html: emptyHtml,
          updateAt: card.updateAt || '',
        };
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (error) {
        console.error('Failed to save to localStorage:', error);
      }
      return;
    }
    
    try {
      let html: string;
      if (wsRef.current) {
        const requestId = `md_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        html = await new Promise<string>((resolve, reject) => {
          wsRequestMapRef.current.set(requestId, { resolve, reject });
          wsRef.current.send(JSON.stringify({
            type: 'request_markdown',
            requestId,
            text: card.content || '',
            inline: false,
          }));
          setTimeout(() => {
            if (wsRequestMapRef.current.has(requestId)) {
              wsRequestMapRef.current.delete(requestId);
              reject(new Error('Markdown request timeout'));
            }
          }, 30000);
        });
      } else {
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
        html = await response.text();
      }
      
      html = await preloadAndCacheImages(html);
      
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
              setTimeout(resolve, 10000);
            }
          });
        });
        await Promise.all(imagePromises);
      }
      
      cardContentCacheRef.current[cardIdStr] = html;
      cachedCardsRef.current.add(cardIdStr);
      
      try {
        const cacheKey = `mindmap-outline-card-${cardIdStr}`;
        const cacheData = {
          html: html,
          updateAt: card.updateAt || '',
        };
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (error) {
        console.error('Failed to save to localStorage:', error);
      }
    } catch (error) {
      console.error(`Failed to preload card ${card.docId}:`, error);
      const errorHtml = '<p style="color: #f44336;">加载内容失败</p>';
      cardContentCacheRef.current[cardIdStr] = errorHtml;
      cachedCardsRef.current.add(cardIdStr);
    }
  }, [preloadAndCacheImages]);

  // 清除单个 card 的缓存
  const clearCardCache = useCallback((cardId: string) => {
    const cardIdStr = String(cardId);
    // 清除内存缓存
    delete cardContentCacheRef.current[cardIdStr];
    cachedCardsRef.current.delete(cardIdStr);
    // 清除 localStorage 缓存
    try {
      const cacheKey = `mindmap-outline-card-${cardIdStr}`;
      localStorage.removeItem(cacheKey);
    } catch (error) {
      console.error(`Failed to remove cache for ${cardIdStr}:`, error);
    }
    // 如果当前选中的是这个 card，重新加载
    if (selectedCard && String(selectedCard.docId) === cardIdStr) {
      const currentCard = selectedCard;
      setSelectedCard(null);
      setTimeout(() => {
        setSelectedCard(currentCard);
      }, 100);
    }
    // 更新缓存状态
    if (cacheStatus) {
      setCacheStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          outdated: prev.outdated.filter(item => item.cardId !== cardIdStr),
        };
      });
    }
  }, [selectedCard, cacheStatus]);

  // 清除 node 下所有 card 的缓存
  const clearNodeCache = useCallback((nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[nodeId] || [];
    
    // 清除该 node 下所有 card 的缓存
    nodeCards.forEach((card: Card) => {
      const cardIdStr = String(card.docId);
      delete cardContentCacheRef.current[cardIdStr];
      cachedCardsRef.current.delete(cardIdStr);
      try {
        const cacheKey = `mindmap-outline-card-${cardIdStr}`;
        localStorage.removeItem(cacheKey);
      } catch (error) {
        console.error(`Failed to remove cache for ${cardIdStr}:`, error);
      }
    });
    
    // 递归清除子节点的缓存
    const childNodeIds = mindMap.edges
      .filter(edge => edge.source === nodeId)
      .map(edge => edge.target);
    
    childNodeIds.forEach(childNodeId => {
      clearNodeCache(childNodeId);
    });
    
    // 如果当前选中的 card 在这个 node 下，重新加载
    if (selectedCard && selectedCard.nodeId === nodeId) {
      const currentCard = selectedCard;
      setSelectedCard(null);
      setTimeout(() => {
        setSelectedCard(currentCard);
      }, 100);
    }
    
    // 更新缓存状态
    if (cacheStatus) {
      checkCacheStatus();
    }
  }, [mindMap.edges, selectedCard, cacheStatus, checkCacheStatus]);

  // 一键更新所有过期缓存
  const updateOutdatedCache = useCallback(async () => {
    if (!cacheStatus || cacheStatus.outdated.length === 0) return;
    
    setIsUpdatingCache(true);
    setCachingProgress({
      current: 0,
      total: cacheStatus.outdated.length,
    });
    
    try {
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const allCards: Card[] = [];
      Object.values(nodeCardsMap).forEach((cards: Card[]) => {
        if (Array.isArray(cards)) {
          allCards.push(...cards);
        }
      });
      
      // 逐个更新，显示进度，每完成一个就从列表中移除
      const remainingOutdated = [...cacheStatus.outdated];
      for (let i = 0; i < remainingOutdated.length; i++) {
        const item = remainingOutdated[i];
        const card = allCards.find(c => String(c.docId) === item.cardId);
        if (card) {
          // 更新进度显示
          setCachingProgress(prev => {
            if (!prev) return null;
            return {
              ...prev,
              current: i,
              currentCard: card.title || '未命名卡片',
            };
          });
          
          // 清除旧缓存
          delete cardContentCacheRef.current[item.cardId];
          cachedCardsRef.current.delete(item.cardId);
          try {
            const cacheKey = `mindmap-outline-card-${item.cardId}`;
            localStorage.removeItem(cacheKey);
          } catch (error) {
            console.error(`Failed to remove cache for ${item.cardId}:`, error);
          }
          
          // 重新缓存（确保使用最新的 card.updateAt）
          await preloadCardContent(card);
          
          // 等待一小段时间，确保 localStorage 已保存
          await new Promise(resolve => setTimeout(resolve, 50));
          
          // 验证缓存是否已正确保存（检查 updateAt）
          let cacheVerified = false;
          try {
            const cacheKey = `mindmap-outline-card-${item.cardId}`;
            const cachedDataStr = localStorage.getItem(cacheKey);
            if (cachedDataStr) {
              try {
                const cachedData = JSON.parse(cachedDataStr);
                // 检查是否有 html 字段（新格式）
                if (cachedData.html) {
                  // 如果 updateAt 匹配，说明缓存已正确更新
                  if (cachedData.updateAt && card.updateAt && cachedData.updateAt === card.updateAt) {
                    cacheVerified = true;
                  } else {
                    // updateAt 不匹配，但我们已经重新下载了，认为已更新
                    console.warn(`Cache updateAt mismatch for ${item.cardId}: cached=${cachedData.updateAt}, card=${card.updateAt}, but cache was just updated`);
                    cacheVerified = true; // 即使不匹配，也认为已更新（因为我们已经重新下载了）
                  }
                } else {
                  // 没有 html 字段，可能是旧格式
                  cacheVerified = false;
                }
              } catch (e) {
                // 解析失败，可能是旧格式
                cacheVerified = false;
              }
            } else {
              // 没有缓存，说明保存失败
              cacheVerified = false;
            }
          } catch (error) {
            console.error(`Failed to verify cache for ${item.cardId}:`, error);
            cacheVerified = false;
          }
          
          // 如果验证通过，从待更新列表中移除
          if (cacheVerified) {
            setCacheStatus(prev => {
              if (!prev) return null;
              const updatedOutdated = prev.outdated.filter(outdatedItem => outdatedItem.cardId !== item.cardId);
              return {
                outdated: updatedOutdated,
                total: prev.total,
              };
            });
          } else {
            console.warn(`Cache verification failed for ${item.cardId}, keeping it in outdated list`);
          }
        }
        
        // 更新进度
        setCachingProgress(prev => {
          if (!prev) return null;
          return {
            ...prev,
            current: i + 1,
          };
        });
      }
      
      // 不再调用 checkCacheStatus，因为我们已经实时更新了列表
      // 如果列表为空，更新状态显示
      setCacheStatus(prev => {
        if (!prev || prev.outdated.length === 0) {
          return null;
        }
        return prev;
      });
      setCachingProgress(null);
    } catch (error) {
      console.error('Failed to update outdated cache:', error);
    } finally {
      setIsUpdatingCache(false);
      setCachingProgress(null);
    }
  }, [cacheStatus, preloadCardContent]);

  // 缓存指定 node 的所有 card 的 markdown 内容
  const cacheNodeCards = useCallback(async (nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || []).sort((a: Card, b: Card) => {
      const orderA = (a.order as number) || 0;
      const orderB = (b.order as number) || 0;
      return orderA - orderB;
    });
    
    if (nodeCards.length === 0) return;
    
    const cardsToCache = nodeCards.filter((card: Card) => {
      const cardIdStr = String(card.docId);
      return !cachedCardsRef.current.has(cardIdStr);
    });
    
    if (cardsToCache.length === 0) {
      setCachingProgress(null);
      return;
    }
    
    console.log(`[MindMap Outline] 开始缓存 node ${nodeId} 下的 ${cardsToCache.length} 个 card`);
    
    // 显示进度
    setCachingProgress({ current: 0, total: cardsToCache.length });
    
    const batchSize = 5;
    for (let i = 0; i < cardsToCache.length; i += batchSize) {
      const batch = cardsToCache.slice(i, i + batchSize);
      await Promise.all(batch.map(async (card: Card) => {
        await preloadCardContent(card);
        setCachingProgress(prev => {
          if (!prev) return null;
          const newCurrent = prev.current + 1;
          return {
            ...prev,
            current: newCurrent,
            currentCard: card.title || '未命名卡片',
          };
        });
      }));
    }
    
    console.log(`[MindMap Outline] 完成缓存 node ${nodeId} 下的 card`);
    // 延迟隐藏进度条，让用户看到完成状态
    setTimeout(() => {
      setCachingProgress(null);
    }, 500);
  }, [preloadCardContent]);

  // 全量预加载所有card - 暂时注释掉
  /*
  const preloadAllCards = useCallback(async () => {
    // 所有缓存逻辑已注释
  }, []);
  */

  // 开始缓存 - 暂时注释掉
  /*
  const startCaching = useCallback(() => {
    // 所有缓存逻辑已注释
  }, []);
  */

  // 暂停缓存 - 暂时注释掉
  /*
  const pauseCaching = useCallback(() => {
    // 所有缓存逻辑已注释
  }, []);
  */

  // 删除缓存 - 暂时注释掉
  /*
  const clearCache = useCallback(async () => {
    // 所有缓存逻辑已注释
  }, []);
  */

  // 计算缓存大小 - 暂时注释掉
  /* const getCacheSize = useCallback(() => {
    let size = 0;
    Object.values(cardContentCacheRef.current).forEach((html: string) => {
      size += new Blob([html]).size;
    });
    return size;
  }, []);

  // 格式化缓存大小 - 暂时注释掉
  /* const formatCacheSize = useCallback((bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }, []); */

  // 选择card
  const handleSelectCard = useCallback((card: Card, skipUrlUpdate = false) => {
    setSelectedCard(card);
    
    // 更新URL参数（除非skipUrlUpdate为true）
    if (!skipUrlUpdate) {
      const urlParams = new URLSearchParams(window.location.search);
      urlParams.set('cardId', String(card.docId));
      urlParams.delete('nodeId'); // 清除nodeId参数
      const newUrl = window.location.pathname + '?' + urlParams.toString();
      window.history.pushState({ cardId: card.docId }, '', newUrl);
    }
  }, []);

  // 根据URL参数加载对应的card或node（只在初始化或URL变化时执行）
  useEffect(() => {
    // 如果正在手动设置选择，跳过
    if (isManualSelectionRef.current) {
      isManualSelectionRef.current = false;
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    const nodeId = urlParams.get('nodeId');
    
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
          setSelectedNodeId(null); // 清除node选择
        }
      }
    } else if (nodeId && fileTree.length > 0) {
      // 在fileTree中查找对应的node
      const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
      if (nodeFile && (!selectedNodeId || selectedNodeId !== nodeId)) {
        setSelectedNodeId(nodeId);
        setSelectedCard(null); // 清除card选择
      }
    } else if (!cardId && !nodeId) {
      // 如果URL中没有参数，清除选择
      setSelectedCard(null);
      setSelectedNodeId(null);
    }
  }, [fileTree, selectedCard, selectedNodeId, handleSelectCard]);

  // 监听浏览器前进/后退事件
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const urlParams = new URLSearchParams(window.location.search);
      const cardId = urlParams.get('cardId');
      const nodeId = urlParams.get('nodeId');
      
      // 标记为popstate事件，避免useEffect干扰
      isManualSelectionRef.current = false;
      
      if (cardId && fileTree.length > 0) {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
        if (cardFile) {
          const nodeCards = nodeCardsMap[cardFile.nodeId || ''] || [];
          const card = nodeCards.find((c: Card) => c.docId === cardId);
          if (card && (!selectedCard || selectedCard.docId !== card.docId)) {
            handleSelectCard(card, true); // 跳过URL更新，避免循环
            setSelectedNodeId(null); // 清除node选择
          }
        }
      } else if (nodeId && fileTree.length > 0) {
        const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
        if (nodeFile && (!selectedNodeId || selectedNodeId !== nodeId)) {
          setSelectedNodeId(nodeId);
          setSelectedCard(null); // 清除card选择
        }
      } else if (!cardId && !nodeId) {
        setSelectedCard(null);
        setSelectedNodeId(null);
      }
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [fileTree, selectedCard, selectedNodeId, handleSelectCard]);

  // 渲染card内容（优先使用缓存）
  useEffect(() => {
    if (!selectedCard) return;
    
    const contentDiv = document.getElementById('card-content-outline');
    if (!contentDiv) return;
    
    const cardIdStr = String(selectedCard.docId);
    
    // 检查缓存（优先从内存缓存读取）
    if (cardContentCacheRef.current[cardIdStr]) {
      contentDiv.innerHTML = cardContentCacheRef.current[cardIdStr];
      $(contentDiv).trigger('vjContentNew');
      
      // 异步缓存该 node 下的其他 card
      const nodeId = selectedCard.nodeId || '';
      if (nodeId) {
        cacheNodeCards(nodeId).catch(error => {
          console.error('Failed to cache node cards:', error);
        });
      }
      return;
    }
    
    // 检查 localStorage 缓存
    try {
      const cacheKey = `mindmap-outline-card-${cardIdStr}`;
      const cachedHtml = localStorage.getItem(cacheKey);
      if (cachedHtml) {
        cardContentCacheRef.current[cardIdStr] = cachedHtml;
        cachedCardsRef.current.add(cardIdStr);
        contentDiv.innerHTML = cachedHtml;
        $(contentDiv).trigger('vjContentNew');
        
        // 异步缓存该 node 下的其他 card
        const nodeId = selectedCard.nodeId || '';
        if (nodeId) {
          cacheNodeCards(nodeId).catch(error => {
            console.error('Failed to cache node cards:', error);
          });
        }
        return;
      }
    } catch (error) {
      console.error('Failed to read from localStorage:', error);
    }
    
    // 缓存中没有，显示加载状态并渲染
    if (selectedCard.content) {
      contentDiv.innerHTML = '<p style="color: #999; text-align: center;">加载中...</p>';
      
      const renderMarkdown = async () => {
        if (wsRef.current) {
          const requestId = `md_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          return new Promise<string>((resolve, reject) => {
            wsRequestMapRef.current.set(requestId, { resolve, reject });
            wsRef.current.send(JSON.stringify({
              type: 'request_markdown',
              requestId,
              text: selectedCard.content || '',
              inline: false,
            }));
            setTimeout(() => {
              if (wsRequestMapRef.current.has(requestId)) {
                wsRequestMapRef.current.delete(requestId);
                reject(new Error('Markdown request timeout'));
              }
            }, 30000);
          });
        } else {
          const response = await fetch('/markdown', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: selectedCard.content || '',
              inline: false,
            }),
          });
          if (!response.ok) {
            throw new Error('Failed to render markdown');
          }
          return response.text();
        }
      };
      
      renderMarkdown()
      .then(async html => {
        // 先显示 markdown 内容（不等待图片加载）
        contentDiv.innerHTML = html;
        $(contentDiv).trigger('vjContentNew');
        
        // 缓存渲染结果（不包含缓存的图片 URL）
        cardContentCacheRef.current[cardIdStr] = html;
        cachedCardsRef.current.add(cardIdStr);
        
        // 保存到 localStorage
        try {
          const cacheKey = `mindmap-outline-card-${cardIdStr}`;
          const cacheData = {
            html: html,
            updateAt: selectedCard.updateAt || '',
          };
          localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (error) {
          console.error('Failed to save to localStorage:', error);
        }
        
        // 异步加载并缓存图片（不阻塞显示）
        preloadAndCacheImages(html).then(async (htmlWithCachedImages) => {
          // 更新显示和缓存（包含缓存的图片 URL）
          contentDiv.innerHTML = htmlWithCachedImages;
          $(contentDiv).trigger('vjContentNew');
          cardContentCacheRef.current[cardIdStr] = htmlWithCachedImages;
          try {
            const cacheKey = `mindmap-outline-card-${cardIdStr}`;
            const cacheData = {
              html: htmlWithCachedImages,
              updateAt: selectedCard.updateAt || '',
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
          } catch (error) {
            console.error('Failed to update localStorage with cached images:', error);
          }
        }).catch(error => {
          console.error('Failed to cache images:', error);
        });
        
        // 异步缓存该 node 下的其他 card
        const nodeId = selectedCard.nodeId || '';
        if (nodeId) {
          cacheNodeCards(nodeId).catch(error => {
            console.error('Failed to cache node cards:', error);
          });
        }
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
      cachedCardsRef.current.add(cardIdStr);
      contentDiv.innerHTML = emptyHtml;
    }
  }, [selectedCard, preloadAndCacheImages, cacheNodeCards, preloadCardContent]);


  // 检查是否从编辑页面返回，如果是则刷新当前 card
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const fromEdit = urlParams.get('fromEdit');
    const cardId = urlParams.get('cardId');
    
    if (fromEdit === 'true' && cardId && selectedCard && String(selectedCard.docId) === cardId) {
      // 清除该 card 的缓存
      const cardIdStr = String(selectedCard.docId);
      delete cardContentCacheRef.current[cardIdStr];
      cachedCardsRef.current.delete(cardIdStr);
      
      // 清除 localStorage 缓存
      try {
        const cacheKey = `mindmap-outline-card-${cardIdStr}`;
        localStorage.removeItem(cacheKey);
      } catch (error) {
        console.error('Failed to remove from localStorage:', error);
      }
      
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
          
          // 更新选中的 card 数据
          const nodeCards = updatedMap[selectedCard.nodeId || ''] || [];
          const updatedCard = nodeCards.find((c: Card) => c.docId === selectedCard.docId);
          if (updatedCard) {
            setSelectedCard(updatedCard);
          }
        }
        
        // 移除 URL 中的 fromEdit 参数
        urlParams.delete('fromEdit');
        const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, '', newUrl);
      }).catch((error) => {
        console.error('Failed to reload data:', error);
      });
    }
  }, [docId, selectedCard]);

  // 监听数据更新（WebSocket 连接）
  useEffect(() => {
    // 如果已经有 WebSocket 连接，不重复连接
    if (wsRef.current) {
      return;
    }

    let ws: any = null;
    const domainId = (window as any).UiContext?.domainId || 'system';
    const wsUrl = `/d/${domainId}/mindmap/${docId}/ws`;

    // 连接 WebSocket 的函数
    const connectWebSocket = () => {
      import('../components/socket').then(({ default: WebSocket }) => {
        // 再次检查，避免重复连接
        if (wsRef.current) {
          return;
        }

        ws = new WebSocket(wsUrl, false, true);

        ws.onopen = () => {
          console.log('[MindMap Outline] WebSocket connected');
          // 不再自动缓存，只在点击 card 时缓存
        };

        ws.onmessage = (_: any, data: string) => {
          try {
            const msg = JSON.parse(data);
            console.log('[MindMap Outline] WebSocket message:', msg);

            // 处理缓存响应
            if (msg.type === 'markdown_response') {
              const { requestId, html, error } = msg;
              const requestHandler = wsRequestMapRef.current.get(requestId);
              if (requestHandler) {
                wsRequestMapRef.current.delete(requestId);
                if (error) {
                  requestHandler.reject(new Error(error));
                } else {
                  requestHandler.resolve(html);
                }
              }
            } else if (msg.type === 'image_response') {
              const { requestId, data: imageData, error } = msg;
              const requestHandler = wsRequestMapRef.current.get(requestId);
              if (requestHandler) {
                wsRequestMapRef.current.delete(requestId);
                if (error) {
                  requestHandler.reject(new Error(error));
                } else {
                  requestHandler.resolve(imageData);
                }
              }
            } else if (msg.type === 'init' || msg.type === 'update') {
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
                  
                  // 如果当前有选中的 card，更新其数据
                  if (selectedCard) {
                    const nodeCards = updatedMap[selectedCard.nodeId || ''] || [];
                    const updatedCard = nodeCards.find((c: Card) => c.docId === selectedCard.docId);
                    if (updatedCard) {
                      // 清除缓存
                      const cardIdStr = String(selectedCard.docId);
                      delete cardContentCacheRef.current[cardIdStr];
                      cachedCardsRef.current.delete(cardIdStr);
                      try {
                        const cacheKey = `mindmap-outline-card-${cardIdStr}`;
                        localStorage.removeItem(cacheKey);
                      } catch (error) {
                        console.error('Failed to remove from localStorage:', error);
                      }
                      setSelectedCard(updatedCard);
                    }
                  }
                  
                  // 预加载新卡片内容
                  const allCards: Card[] = [];
                  Object.values(updatedMap).forEach((cards: Card[]) => {
                    if (Array.isArray(cards)) {
                      allCards.push(...cards);
                    }
                  });
                  
                  // 清除缓存并重新开始缓存 - 暂时注释掉
                  // 所有缓存逻辑已注释
                }
              }).catch((error) => {
                console.error('Failed to reload data:', error);
              });
            }
          } catch (error) {
            console.error('[MindMap Outline] Failed to parse WebSocket message:', error);
          }
        };
        
        // 保存 WebSocket 引用
        wsRef.current = ws;

        ws.onclose = () => {
          console.log('[MindMap Outline] WebSocket closed');
          ws = null;
          wsRef.current = null;
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
      // 清除引用
      if (wsRef.current === ws) {
        wsRef.current = null;
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
        {/* 缓存管理按钮 - 暂时注释掉 */}
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
        {/* 缓存管理侧边栏 - 暂时注释掉 */}
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
                  已缓存: {cachedCount} 个卡片
                </div>
                <div style={{ fontSize: '13px', color: '#333' }}>
                  缓存大小: {formatCacheSize(getCacheSize())}
                </div>
              </div>

              {cachingProgress && (
                <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f6f8fa', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>📄 卡片缓存进度</div>
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

              {imageCachingProgress && (
                <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#fff3e0', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>🖼️ 图片缓存进度</div>
                  <div style={{ 
                    width: '100%', 
                    height: '8px', 
                    backgroundColor: '#e0e0e0', 
                    borderRadius: '4px',
                    overflow: 'hidden',
                    marginBottom: '8px',
                  }}>
                    <div style={{
                      width: `${(imageCachingProgress.current / imageCachingProgress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#ff9800',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', textAlign: 'center' }}>
                    {imageCachingProgress.current} / {imageCachingProgress.total}
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', padding: '0 8px' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#666' }}>
                EXPLORER
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <button
                  onClick={() => setExplorerMode('tree')}
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    border: '1px solid #ddd',
                    borderRadius: '3px',
                    backgroundColor: explorerMode === 'tree' ? '#1976d2' : '#fff',
                    color: explorerMode === 'tree' ? '#fff' : '#333',
                    cursor: 'pointer',
                  }}
                  title="文件结构"
                >
                  文件结构
                </button>
                <button
                  onClick={() => {
                    setExplorerMode('cache');
                    // 切换到缓存模式时自动检查状态
                    if (cachedCardsRef.current.size > 0) {
                      checkCacheStatus();
                    }
                  }}
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    border: '1px solid #ddd',
                    borderRadius: '3px',
                    backgroundColor: explorerMode === 'cache' ? '#1976d2' : '#fff',
                    color: explorerMode === 'cache' ? '#fff' : '#333',
                    cursor: 'pointer',
                    position: 'relative',
                  }}
                  title="缓存管理"
                >
                  <span>缓存</span>
                  {cacheStatus && cacheStatus.outdated.length > 0 && (
                    <span style={{
                      position: 'absolute',
                      top: '-4px',
                      right: '-4px',
                      width: '12px',
                      height: '12px',
                      backgroundColor: '#f44336',
                      borderRadius: '50%',
                      border: '2px solid #fff',
                      fontSize: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontWeight: 'bold',
                    }}>
                      {cacheStatus.outdated.length > 9 ? '9+' : cacheStatus.outdated.length}
                    </span>
                  )}
                </button>
              </div>
            </div>
            
            {/* 根据模式显示不同内容 */}
            {explorerMode === 'tree' ? (
              // 文件结构模式 - 文件列表在下面渲染
              null
            ) : (
              // 缓存管理模式
              <div>
                {cacheStatus ? (
                  <div>
                    <div style={{
                      marginBottom: '8px',
                      padding: '8px',
                      backgroundColor: cacheStatus.outdated.length > 0 ? '#fff3e0' : '#e8f5e9',
                      borderRadius: '4px',
                      border: `1px solid ${cacheStatus.outdated.length > 0 ? '#ff9800' : '#4caf50'}`,
                      fontSize: '11px',
                    }}>
                      <div style={{ fontWeight: '600', color: cacheStatus.outdated.length > 0 ? '#e65100' : '#2e7d32', marginBottom: '8px' }}>
                        {cacheStatus.outdated.length > 0 ? `⚠️ ${cacheStatus.outdated.length} 个缓存需要更新` : `✅ 所有缓存都是最新的`}
                      </div>
                      {cacheStatus.outdated.length > 0 && (
                        <>
                          <div style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '8px' }}>
                            {cacheStatus.outdated.map(item => (
                              <div key={item.cardId} style={{
                                padding: '6px 8px',
                                marginBottom: '4px',
                                backgroundColor: '#fff',
                                borderRadius: '2px',
                                fontSize: '11px',
                                color: '#666',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                border: '1px solid #e0e0e0',
                              }}>
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {item.title}
                                </span>
                                <span style={{ marginLeft: '8px', color: '#999', fontSize: '10px', whiteSpace: 'nowrap' }}>
                                  {item.cachedUpdateAt !== '未知' ? new Date(item.cachedUpdateAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '旧格式'}
                                </span>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={updateOutdatedCache}
                            disabled={isUpdatingCache}
                            style={{
                              width: '100%',
                              padding: '8px',
                              backgroundColor: isUpdatingCache ? '#ccc' : '#4caf50',
                              color: '#fff',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '12px',
                              fontWeight: '500',
                              cursor: isUpdatingCache ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '6px',
                            }}
                            onMouseEnter={(e) => {
                              if (!isUpdatingCache) {
                                e.currentTarget.style.backgroundColor = '#388e3c';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isUpdatingCache) {
                                e.currentTarget.style.backgroundColor = '#4caf50';
                              }
                            }}
                          >
                            <span>{isUpdatingCache ? '⏳' : '🔄'}</span>
                            <span>{isUpdatingCache ? '更新中...' : '更新所有'}</span>
                          </button>
                          {cachingProgress && isUpdatingCache && (
                            <div style={{ marginTop: '8px', padding: '4px', backgroundColor: '#fff', borderRadius: '2px' }}>
                              <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px', textAlign: 'center' }}>
                                {cachingProgress.currentCard && `${cachingProgress.currentCard} - `}
                                {cachingProgress.current} / {cachingProgress.total}
                              </div>
                              <div style={{
                                width: '100%',
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
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{
                    padding: '16px',
                    textAlign: 'center',
                    color: '#999',
                    fontSize: '12px',
                  }}>
                    {isCheckingCache ? '检查中...' : '点击"文件结构"按钮查看文件，或等待自动检查缓存状态'}
                  </div>
                )}
              </div>
            )}
            {explorerMode === 'tree' && fileTree.map((file) => {
              // 检查缓存状态
              let isCached = false;
              if (file.type === 'card') {
                // 检查 card 是否已缓存
                const cardIdStr = String(file.cardId);
                isCached = cachedCardsRef.current.has(cardIdStr);
              } else if (file.type === 'node') {
                // 递归检查 node 及其所有子节点和子卡片是否都已缓存
                isCached = checkNodeCached(file.nodeId || '');
              }
              
              return (
                <div
                  key={file.id}
                  onClick={() => {
                    if (file.type === 'card') {
                      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                      const nodeCards = nodeCardsMap[file.nodeId || ''] || [];
                      const card = nodeCards.find((c: Card) => c.docId === file.cardId);
                      if (card) {
                        // 标记为手动选择，避免useEffect干扰
                        isManualSelectionRef.current = true;
                        handleSelectCard(card);
                        setSelectedNodeId(null); // 清除node选择
                        // handleSelectCard内部已经更新URL了
                      }
                    } else {
                      // 点击node，显示该node的缩略图
                      const nodeId = file.nodeId || null;
                      
                      // 标记为手动选择，避免useEffect干扰
                      isManualSelectionRef.current = true;
                      setSelectedNodeId(nodeId);
                      setSelectedCard(null); // 清除card选择
                      
                      // 更新URL参数
                      const urlParams = new URLSearchParams(window.location.search);
                      if (nodeId) {
                        urlParams.set('nodeId', nodeId);
                        urlParams.delete('cardId'); // 清除cardId参数
                      } else {
                        urlParams.delete('nodeId');
                      }
                      const newUrl = window.location.pathname + '?' + urlParams.toString();
                      window.history.pushState({ nodeId }, '', newUrl);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, file });
                  }}
                  style={{
                    padding: `4px ${8 + file.level * 16}px`,
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: isCached ? '#333' : '#999',
                    fontWeight: isCached ? '600' : 'normal',
                    backgroundColor: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
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

        {/* 右侧内容显示区域 */}
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
                <a
                  href={(() => {
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    const branch = (window as any).UiContext?.currentBranch || 'main';
                    const mindMapDocId = (window as any).UiContext?.mindMap?.docId;
                    const mindMapMmid = (window as any).UiContext?.mindMap?.mmid;
                    const nodeId = selectedCard.nodeId || '';
                    const cardId = selectedCard.docId;
                    
                    if (mindMapDocId) {
                      return `/d/${domainId}/mindmap/${mindMapDocId}/branch/${branch}/node/${encodeURIComponent(nodeId)}/card/${cardId}/edit?returnUrl=${encodeURIComponent(window.location.href)}`;
                    } else if (mindMapMmid) {
                      return `/d/${domainId}/mindmap/mmid/${mindMapMmid}/branch/${branch}/node/${encodeURIComponent(nodeId)}/card/${cardId}/edit?returnUrl=${encodeURIComponent(window.location.href)}`;
                    }
                    return '#';
                  })()}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: '#1976d2',
                    color: '#fff',
                    textDecoration: 'none',
                    borderRadius: '4px',
                    fontSize: '13px',
                    fontWeight: '500',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#1565c0';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#1976d2';
                  }}
                >
                  <span>✎</span>
                  <span>编辑</span>
                </a>
              </div>
              {cachingProgress && (
                <div style={{
                  marginTop: '12px',
                  padding: '8px 12px',
                  backgroundColor: '#fff',
                  borderRadius: '4px',
                  border: '1px solid #e0e0e0',
                }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '6px' }}>
                    正在缓存同节点下的其他卡片...
                  </div>
                  <div style={{ 
                    width: '100%', 
                    height: '6px', 
                    backgroundColor: '#e0e0e0', 
                    borderRadius: '3px',
                    overflow: 'hidden',
                    marginBottom: '4px',
                  }}>
                    <div style={{
                      width: `${(cachingProgress.current / cachingProgress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#4caf50',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '11px', color: '#999', textAlign: 'center' }}>
                    {cachingProgress.current} / {cachingProgress.total}
                    {cachingProgress.currentCard && ` - ${cachingProgress.currentCard}`}
                  </div>
                </div>
              )}
            </div>
            <div style={{
              flex: 1,
              padding: '16px',
              overflow: 'auto',
            }}>
              <div
                id="card-content-outline"
                className="typo topic__content richmedia"
                data-emoji-enabled
                style={{
                  padding: '16px',
                }}
                dangerouslySetInnerHTML={{ __html: '<p style="color: #999;">加载中...</p>' }}
              />
            </div>
          </div>
        ) : selectedNodeId ? (
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
                  {mindMap.nodes.find(n => n.id === selectedNodeId)?.text || '未命名节点'}
                </h3>
              </div>
            </div>
            <div style={{
              flex: 1,
              overflow: 'auto',
            }}>
              {(() => {
                const subgraph = getNodeSubgraph(selectedNodeId);
                return (
        <OutlineView
                    nodes={subgraph.nodes}
                    edges={subgraph.edges}
                    onToggleExpand={handleNodeToggleExpand}
                    onNodeClick={handleNodeClick}
          selectedNodeId={selectedNodeId}
                    rootNodeId={selectedNodeId}
        />
                );
              })()}
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
            请从左侧选择一个节点或卡片
          </div>
        )}
      </div>
      
      {/* 右键菜单 */}
      {contextMenu && (
        <>
          {/* 背景遮罩，点击关闭菜单 */}
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999,
            }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          {/* 菜单 */}
          <div
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top: contextMenu.y,
              backgroundColor: '#fff',
              border: '1px solid #ddd',
              borderRadius: '4px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              zIndex: 1000,
              minWidth: '180px',
              padding: '4px 0',
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {contextMenu.file.type === 'card' ? (
              <>
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#24292e',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    if (contextMenu.file.cardId) {
                      clearCardCache(contextMenu.file.cardId);
                    }
                    setContextMenu(null);
                  }}
                >
                  🗑 清除缓存
                </div>
              </>
            ) : (
              <>
                <div
                  style={{
                    padding: '6px 16px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#24292e',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    if (contextMenu.file.nodeId) {
                      clearNodeCache(contextMenu.file.nodeId);
                    }
                    setContextMenu(null);
                  }}
                >
                  🗑 清除节点缓存
                </div>
              </>
            )}
          </div>
        </>
      )}
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


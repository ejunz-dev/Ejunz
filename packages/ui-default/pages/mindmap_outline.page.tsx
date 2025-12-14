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

  // 卡片内容缓存
  const cardContentCacheRef = useRef<Record<string, string>>({});
  const imageCacheRef = useRef<Cache | null>(null);
  // 缓存状态：记录哪些card已经被缓存
  const cachedCardsRef = useRef<Set<string>>(new Set());
  // 缓存计数
  const [cachedCount, setCachedCount] = useState(0);
  // 缓存进度：记录正在缓存的进度
  const [cachingProgress, setCachingProgress] = useState<{ current: number; total: number } | null>(null);
  // 缓存控制：是否暂停缓存
  const [isCachingPaused, setIsCachingPaused] = useState(false);
  // 缓存管理侧边栏是否显示
  const [showCachePanel, setShowCachePanel] = useState(false);
  // 缓存任务是否正在运行
  const cachingTaskRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  // WebSocket 连接 ref（用于缓存请求）
  const wsRef = useRef<any>(null);
  // WebSocket 请求的 Promise Map（用于处理响应）
  const wsRequestMapRef = useRef<Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>>(new Map());

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

      // 如果节点展开，显示其卡片和子节点（按order混合排序）
      if (isExpanded) {
        // 获取该节点的卡片（按 order 排序）
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        // 获取子节点（按 order 排序）
        const childNodes = children
          .map(childId => {
            const childNode = mindMap.nodes.find(n => n.id === childId);
            return childNode ? { id: childId, node: childNode, order: childNode.order || 0 } : null;
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

  // 使用ref来存储preloadCardContent函数，避免循环依赖和初始化顺序问题
  const preloadCardContentRef = useRef<((card: Card) => Promise<void>) | null>(null);

  // 全量预加载所有card
  const preloadAllCards = useCallback(async () => {
    if (isCachingPaused || cachingTaskRef.current.cancelled) {
      return;
    }

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const allCards: Card[] = [];
    
    // 收集所有card
    Object.values(nodeCardsMap).forEach((cards: Card[]) => {
      if (Array.isArray(cards)) {
        allCards.push(...cards);
      }
    });

    // 过滤掉已经缓存的card
    const cardsToPreload = allCards.filter(card => {
      const cardIdStr = String(card.docId);
      return !cachedCardsRef.current.has(cardIdStr);
    });

    if (cardsToPreload.length === 0) {
      setCachingProgress(null);
      return;
    }

    // 显示进度
    setCachingProgress({ current: 0, total: cardsToPreload.length });

    // 逐个预加载card
    for (let i = 0; i < cardsToPreload.length; i++) {
      // 检查是否暂停或取消
      if (isCachingPaused || cachingTaskRef.current.cancelled) {
        break;
      }

      const card = cardsToPreload[i];
      
      // 使用ref调用preloadCardContent函数
      try {
        if (preloadCardContentRef.current) {
          await preloadCardContentRef.current(card);
        } else {
          console.warn('preloadCardContentRef not set yet, waiting...');
          // 等待一下，让ref被设置
          await new Promise(resolve => setTimeout(resolve, 100));
          if (preloadCardContentRef.current) {
            await preloadCardContentRef.current(card);
          } else {
            console.error('preloadCardContentRef still not set after waiting');
          }
        }
      } catch (error) {
        console.error(`Failed to preload card ${card.docId}:`, error);
      }
      
      // 更新进度
      setCachingProgress({ current: i + 1, total: cardsToPreload.length });
    }

    // 如果完成或取消，隐藏进度
    if (!isCachingPaused && !cachingTaskRef.current.cancelled) {
      setCachingProgress(null);
    }
  }, [isCachingPaused]);

  // 开始缓存
  const startCaching = useCallback(() => {
    console.log('[Cache] Starting cache...');
    setIsCachingPaused(false);
    cachingTaskRef.current.cancelled = false;
    
    // 检查是否有卡片需要缓存
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const allCards: Card[] = [];
    Object.values(nodeCardsMap).forEach((cards: Card[]) => {
      if (Array.isArray(cards)) {
        allCards.push(...cards);
      }
    });
    
    if (allCards.length === 0) {
      console.log('[Cache] No cards to cache');
      return;
    }
    
    console.log(`[Cache] Found ${allCards.length} cards, starting preload...`);
    preloadAllCards();
  }, [preloadAllCards]);

  // 暂停缓存
  const pauseCaching = useCallback(() => {
    setIsCachingPaused(true);
  }, []);

  // 删除缓存
  const clearCache = useCallback(async () => {
    // 清空内容缓存
    cardContentCacheRef.current = {};
    cachedCardsRef.current.clear();
    setCachedCount(0);
    
    // 清空图片缓存
    if (imageCacheRef.current) {
      try {
        await caches.delete('mindmap-card-images-v1');
        imageCacheRef.current = null;
      } catch (error) {
        console.error('Failed to clear image cache:', error);
      }
    }
    
    // 重置进度
    setCachingProgress(null);
    cachingTaskRef.current.cancelled = true;
    
    Notification.success('缓存已清空');
  }, []);

  // 计算缓存大小
  const getCacheSize = useCallback(() => {
    let size = 0;
    Object.values(cardContentCacheRef.current).forEach((html: string) => {
      size += new Blob([html]).size;
    });
    return size;
  }, []);

  // 格式化缓存大小
  const formatCacheSize = useCallback((bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }, []);

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

  // 从缓存或网络获取图片（通过 WebSocket）
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
      
      // 通过 WebSocket 请求图片
      if (wsRef.current) {
        const requestId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const imageDataUrl = await new Promise<string>((resolve, reject) => {
          wsRequestMapRef.current.set(requestId, { resolve, reject });
          wsRef.current.send(JSON.stringify({
            type: 'request_image',
            requestId,
            url,
          }));
          // 超时处理
          setTimeout(() => {
            if (wsRequestMapRef.current.has(requestId)) {
              wsRequestMapRef.current.delete(requestId);
              reject(new Error('Image request timeout'));
            }
          }, 30000);
        });
        
        // 将 base64 data URL 转换为 blob 并缓存
        const response = await fetch(imageDataUrl);
        const blob = await response.blob();
        await imageCacheRef.current.put(url, new Response(blob));
        return URL.createObjectURL(blob);
      }
      
      // 如果 WebSocket 不可用，回退到 HTTP
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

  // 预渲染卡片内容（通过 WebSocket）
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
      let html: string;
      
      // 通过 WebSocket 请求 markdown 渲染
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
          // 超时处理
          setTimeout(() => {
            if (wsRequestMapRef.current.has(requestId)) {
              wsRequestMapRef.current.delete(requestId);
              reject(new Error('Markdown request timeout'));
            }
          }, 30000);
        });
      } else {
        // 如果 WebSocket 不可用，回退到 HTTP
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
      cachedCardsRef.current.add(cardIdStr);
      setCachedCount(cachedCardsRef.current.size);
    } catch (error) {
      console.error(`Failed to preload card ${card.docId}:`, error);
      cardContentCacheRef.current[cardIdStr] = '<p style="color: #f44336;">加载内容失败</p>';
    }
  }, [preloadAndCacheImages]);

  // 将preloadCardContent存储到ref中
  useEffect(() => {
    preloadCardContentRef.current = preloadCardContent;
  }, [preloadCardContent]);

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
      
      // 通过 WebSocket 请求 markdown 渲染
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
            // 超时处理
            setTimeout(() => {
              if (wsRequestMapRef.current.has(requestId)) {
                wsRequestMapRef.current.delete(requestId);
                reject(new Error('Markdown request timeout'));
              }
            }, 30000);
          });
        } else {
          // 如果 WebSocket 不可用，回退到 HTTP
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
          // WebSocket 连接建立后，如果还没有开始缓存，自动开始缓存
          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
          if (Object.keys(nodeCardsMap).length > 0 && cachedCount === 0 && !isCachingPaused) {
            setTimeout(() => {
              startCaching();
            }, 500);
          }
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
    };
  }, [docId, selectedCard, startCaching]);

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
        <button
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
        </button>
        <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
          {mindMap.title} - 文件模式
        </div>
      </div>

      {/* 主内容区域 */}
      <div style={{ display: 'flex', flex: 1, width: '100%', position: 'relative', backgroundColor: '#fff' }}>
        {/* 缓存管理侧边栏 */}
        {showCachePanel && (
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
        )}

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
              const isSelectedCard = file.type === 'card' && selectedCard && file.cardId === selectedCard.docId;
              const isSelectedNode = file.type === 'node' && selectedNodeId === file.nodeId;
              const isSelected = isSelectedCard || isSelectedNode;
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


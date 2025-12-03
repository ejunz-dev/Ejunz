import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import ReactFlow, {
  Node,
  Edge,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';

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
}

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
                  <a
                    key={card.docId || card.cid}
                    href={getCardUrl(card, nodeId)}
                    onClick={(e) => {
                      e.stopPropagation();
                      // 在新标签页打开
                      window.open(getCardUrl(card, nodeId), '_blank');
                      e.preventDefault();
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
                  </a>
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  
  // 先定义状态
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // 使用 ref 存储最新的节点和边状态，确保保存时获取最新数据
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

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

  // 同步 ref 和 state
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // 自动保存的防抖定时器
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 辅助函数：获取带 domainId 的 mindmap URL
  const getMindMapUrl = (path: string, docId: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    return `/d/${domainId}/mindmap/${docId}${path}`;
  };

  // 保存思维导图
  // isAutoSave: 是否为自动保存，自动保存时不显示成功提示
  const handleSave = useCallback(async (isAutoSave: boolean = false) => {
    try {
      // 使用 ref 获取最新的节点和边状态
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;

      // 收集所有节点的位置和属性
      const updatedNodes = currentNodes.map((node) => {
        const originalNode = node.data.originalNode as MindMapNode;
        // 确保位置是有效的数字
        const x = typeof node.position.x === 'number' && !isNaN(node.position.x) 
          ? node.position.x 
          : (originalNode.x || 0);
        const y = typeof node.position.y === 'number' && !isNaN(node.position.y) 
          ? node.position.y 
          : (originalNode.y || 0);
        
        const updatedNode = {
          ...originalNode,
          x,
          y,
          expanded: originalNode.expanded, // 保存 expanded 状态
        };
        
        return updatedNode;
      });

      // 获取当前视口状态（文件模式不需要视口，但保持兼容性）
      const viewport = undefined;

      const response = await request.post(getMindMapUrl('/save', docId), {
        nodes: updatedNodes,
        edges: currentEdges.map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          style: e.style,
          type: e.type,
          color: (e.style as any)?.stroke,
          width: (e.style as any)?.strokeWidth,
        })),
        viewport: viewport,
        operationDescription: '文件模式保存',
      });
      
      if (!isAutoSave) {
        Notification.success('保存成功');
      }
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
    }
  }, [docId]);

  // 触发自动保存（带防抖）
  const triggerAutoSave = useCallback(() => {
    // 清除之前的定时器（如果有）
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      handleSave(true); // 传入 true 表示自动保存，不显示成功提示
      saveTimerRef.current = null;
    }, 1500);
  }, [handleSave]);

  // 处理节点展开/折叠
  const handleToggleExpand = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const originalNode = node.data.originalNode as MindMapNode;
    if (!originalNode) return;

    const newExpanded = !(originalNode.expanded !== false); // 切换状态，默认为 true

    // 立即更新本地状态，实现即时 UI 响应
    setNodes((nds) => {
      const updatedNodes = nds.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: {
                ...n.data,
                originalNode: {
                  ...originalNode,
                  expanded: newExpanded,
                },
              },
            }
          : n
      );
      // 同时更新 nodesRef，确保自动保存时能获取最新状态
      nodesRef.current = updatedNodes;
      return updatedNodes;
    });

    // 触发自动保存（1.5秒后保存到后端）
    triggerAutoSave();
  }, [nodes, setNodes, triggerAutoSave]);

  // 将 MindMapNode 转换为 ReactFlow Node
  const initialFlowNodes = useMemo(() => {
    const flowEdges = mindMap.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })) as Edge[];
    
    return mindMap.nodes.map((node) => {
      const x = typeof node.x === 'number' && !isNaN(node.x) ? node.x : 0;
      const y = typeof node.y === 'number' && !isNaN(node.y) ? node.y : 0;
      
      return {
        id: node.id,
        type: 'mindmap',
        position: { x, y },
        draggable: false,
        data: {
          originalNode: node,
          edges: flowEdges,
          docId: docId,
          mmid: mindMap.mmid,
          branch: mindMap.currentBranch || 'main',
        },
      } as Node;
    });
  }, [mindMap.nodes, mindMap.edges, docId, mindMap.mmid, mindMap.currentBranch]);

  // 将 MindMapEdge 转换为 ReactFlow Edge
  const initialFlowEdges = useMemo(() => {
    return mindMap.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'custom',
      animated: false,
      style: {
        stroke: edge.color || '#2196f3',
        strokeWidth: edge.width || 2,
      },
    })) as Edge[];
  }, [mindMap.edges]);

  // 初始化节点和边
  useEffect(() => {
    setNodes(initialFlowNodes);
    setEdges(initialFlowEdges);
  }, [initialFlowNodes, initialFlowEdges, setNodes, setEdges]);

  // 当 mindMap 更新时，更新节点和边
  useEffect(() => {
    const flowEdges = mindMap.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })) as Edge[];
    
    const updatedNodes = mindMap.nodes.map((node) => {
      const x = typeof node.x === 'number' && !isNaN(node.x) ? node.x : 0;
      const y = typeof node.y === 'number' && !isNaN(node.y) ? node.y : 0;
      
      return {
        id: node.id,
        type: 'mindmap',
        position: { x, y },
        draggable: false,
        data: {
          originalNode: node,
          edges: flowEdges,
          docId: docId,
          mmid: mindMap.mmid,
          branch: mindMap.currentBranch || 'main',
        },
      } as Node;
    });

    const updatedEdges = mindMap.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'custom',
      animated: false,
      style: {
        stroke: edge.color || '#2196f3',
        strokeWidth: edge.width || 2,
      },
    })) as Edge[];

    setNodes(updatedNodes);
    setEdges(updatedEdges);
  }, [mindMap, docId, setNodes, setEdges]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

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
  }, [docId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', backgroundColor: '#fff' }}>
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
        <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
          {mindMap.title} - 文件模式
        </div>
      </div>

      {/* 文件模式视图 */}
      <div style={{ flex: 1, width: '100%', position: 'relative', backgroundColor: '#fff' }}>
        <OutlineView
          nodes={nodes}
          edges={edges}
          onToggleExpand={handleToggleExpand}
          onNodeClick={setSelectedNodeId}
          selectedNodeId={selectedNodeId}
        />
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


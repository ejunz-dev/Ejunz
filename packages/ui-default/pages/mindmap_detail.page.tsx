import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import { ActionDialog } from 'vj/components/dialog';
import yaml from 'js-yaml';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Connection,
  addEdge,
  useNodesState,
  useEdgesState,
  MarkerType,
  NodeTypes,
  EdgeTypes,
  Handle,
  Position,
  ReactFlowInstance,
  NodeMouseHandler,
  BaseEdge,
  getBezierPath,
  EdgeProps,
} from 'reactflow';
import dagre from 'dagre';
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

const MindMapNodeComponent = ({ data, selected, id }: { data: any; selected: boolean; id: string }) => {
  const node = data.originalNode as MindMapNode;
  const shape = node.shape || 'rectangle';
  const backgroundColor = selected ? (node.backgroundColor || '#e3f2fd') : 'transparent';
  const borderColor = selected ? '#1976d2' : 'transparent';
  const color = node.color || '#333';
  const fontSize = node.fontSize || 14;
  const isNewNode = data.isNewNode || false; // 是否是新创建的节点（还未保存）
  const isEditing = data.isEditing || false; // 是否处于编辑模式
  const edges = data.edges || [];
  const childEdges = edges.filter((edge: Edge) => edge.source === id);
  const hasChildren = childEdges.length > 0;
  const expanded = node.expanded !== false; // 默认为 true（展开）
  
  // 用于编辑的 ref
  const textRef = React.useRef<HTMLDivElement>(null);
  
  // 卡片相关状态
  const [cardCount, setCardCount] = React.useState<number>(0);
  const [showCardPopup, setShowCardPopup] = React.useState<boolean>(false);
  const [cards, setCards] = React.useState<Card[]>([]);
  const cardPopupRef = React.useRef<HTMLDivElement>(null);
  const cardCountRef = React.useRef<HTMLDivElement>(null);
  
  // 从 UiContext 获取卡片数量
  React.useEffect(() => {
    if (isNewNode) {
      setCardCount(0);
      return;
    }
    
    // 从 UiContext 获取节点卡片映射
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[id] || [];
    setCardCount(nodeCards.length || 0);
  }, [id, isNewNode]);
  
  // 从 UiContext 获取卡片列表
  const fetchCards = React.useCallback(() => {
    if (isNewNode) {
      setCards([]);
      return;
    }
    
    // 从 UiContext 获取节点卡片映射
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[id] || [];
    setCards(nodeCards);
  }, [id, isNewNode]);
  
  // 点击卡片数量时显示悬浮窗
  const handleCardCountClick = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (cardCount > 0) {
      setShowCardPopup(true);
      // 从 UiContext 获取卡片列表
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const nodeCards = nodeCardsMap[id] || [];
      setCards(nodeCards);
    }
  }, [cardCount, id]);
  
  // 点击卡片名称跳转
  const handleCardClick = React.useCallback((card: Card) => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = data.branch || 'main';
    const docId = data.docId as string;
    const url = docId 
      ? `/d/${domainId}/mindmap/${docId}/branch/${branch}/node/${id}/cards?cardId=${card.docId}`
      : `/d/${domainId}/mindmap/mmid/${data.mmid}/branch/${branch}/node/${id}/cards?cardId=${card.docId}`;
    window.open(url, '_blank');
  }, [id, data.docId, data.mmid, data.branch]);
  
  // 点击外部关闭悬浮窗
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        cardPopupRef.current && 
        !cardPopupRef.current.contains(target) &&
        cardCountRef.current &&
        !cardCountRef.current.contains(target)
      ) {
        setShowCardPopup(false);
      }
    };
    
    if (showCardPopup) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showCardPopup]);
  
  // 如果是新节点或编辑模式，自动进入编辑模式并 focus
  React.useEffect(() => {
    if ((isNewNode || isEditing)) {
      // 使用多重延迟确保 DOM 已完全渲染并可以 focus
      const focusElement = () => {
        if (textRef.current) {
          // 确保元素可见且可交互
          textRef.current.focus();
          
          // 如果是新节点，准备输入
          if (isNewNode) {
            // 新节点：确保光标在开始位置，可以输入
            try {
              const range = document.createRange();
              range.selectNodeContents(textRef.current);
              range.collapse(true); // 折叠到开始位置
              const selection = window.getSelection();
              if (selection) {
                selection.removeAllRanges();
                selection.addRange(range);
              }
            } catch (e) {
              // 如果选择失败，至少确保 focus
              console.warn('Failed to set selection:', e);
            }
          } else {
            // 编辑模式：将光标移到文本末尾
            try {
              const range = document.createRange();
              range.selectNodeContents(textRef.current);
              range.collapse(false); // 折叠到末尾
              const selection = window.getSelection();
              if (selection) {
                selection.removeAllRanges();
                selection.addRange(range);
              }
            } catch (e) {
              console.warn('Failed to set selection:', e);
            }
          }
        }
      };
      
      // 使用多重延迟确保 DOM 已渲染
      // 先等待一个 tick，再等待下一个 frame，最后执行 focus
      setTimeout(() => {
        requestAnimationFrame(() => {
          setTimeout(focusElement, 50);
        });
      }, 0);
    }
  }, [isNewNode, isEditing]);

  const shapeStyles: Record<string, React.CSSProperties> = {
    rectangle: {
      borderRadius: '8px',
      padding: '6px 10px', // 减少 padding，让框更紧凑
      display: 'inline-block', // 让宽度根据内容自适应
      width: 'fit-content', // 根据内容调整宽度
    },
    circle: {
      borderRadius: '50%',
      padding: '8px',
      minWidth: '40px', // 圆形保持最小尺寸
      minHeight: '40px',
      width: 'fit-content',
      height: 'fit-content',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    ellipse: {
      borderRadius: '50%',
      padding: '6px 12px', // 减少 padding
      display: 'inline-block',
      width: 'fit-content', // 根据内容调整宽度
    },
    diamond: {
      transform: 'rotate(45deg)',
      padding: '8px',
      minWidth: '40px', // 菱形保持最小尺寸
      minHeight: '40px',
      width: 'fit-content',
      height: 'fit-content',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
  };

  const textStyle: React.CSSProperties = {
    transform: shape === 'diamond' ? 'rotate(-45deg)' : 'none',
    textAlign: 'center',
  };

  return (
    <div
      style={{
        ...shapeStyles[shape],
        background: backgroundColor,
        border: `2px solid ${borderColor}`, // 始终有边框，但未选中时透明
        boxShadow: selected ? '0 4px 8px rgba(0,0,0,0.2)' : 'none', // 未选中时不显示阴影
        cursor: data.isRootNode ? 'move' : 'default',
        position: 'relative',
        color: color,
        fontSize: `${fontSize}px`,
        whiteSpace: 'nowrap', // 防止文字换行
      }}
    >
      {/* 连接点 - 隐藏显示但保留功能 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: 'transparent',
          width: '0px',
          height: '0px',
          border: 'none',
          opacity: 0,
        }}
      />

      {/* 可编辑的文本区域 */}
      {(isNewNode || isEditing) ? (
        <div
          ref={textRef}
          contentEditable={true}
          suppressContentEditableWarning={true}
          onBlur={(e) => {
            const newText = e.currentTarget.textContent || '';
            // 如果是新建节点
            if (isNewNode) {
              // 新建节点失去焦点时：
              // 1. 如果没有文本，直接删除节点（不保存）
              // 2. 如果有文本，保存节点
              if (!newText.trim()) {
                // 新节点没有文本，直接删除节点和临时边
                if (data.onDelete) {
                  data.onDelete(id);
                }
              } else {
                // 新节点有文本，保存节点
                if (data.onTextChange) {
                  data.onTextChange(id, newText);
                }
              }
            } else if (isEditing) {
              // 编辑模式（非新节点）失去焦点时：
              // 1. 如果有文本变化，保存
              // 2. 退出编辑模式
              if (data.onTextChange) {
                data.onTextChange(id, newText);
              }
              // 退出编辑模式
              if (data.onExitEdit) {
                data.onExitEdit(id);
              }
            }
          }}
          onKeyDown={(e) => {
            // 按 Enter 键保存并退出编辑
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
            // 阻止事件冒泡，避免触发节点拖拽
            e.stopPropagation();
          }}
          style={{
            ...textStyle,
            outline: '2px solid #2196f3',
            minHeight: '20px',
            cursor: 'text',
          }}
        >
          {node.text || ''}
        </div>
      ) : (
        <div style={textStyle}>
          {node.text || '未命名节点'}
        </div>
      )}

      {/* 为每个子节点创建独立的连接点，避免合并 */}
      {childEdges.length > 0 ? (
        childEdges.map((edge: Edge, index: number) => {
          const childCount = childEdges.length;
          // 根据子节点数量和索引，计算连接点的垂直位置
          // 增加间距，确保连接点足够分散，避免路径合并
          const spacing = 40; // 增加间距到40px
          const offsetY = childCount > 1 
            ? ((index - (childCount - 1) / 2) * spacing) // 多个子节点时分散，使用更大的间距
            : 0; // 单个子节点时居中
          
          return (
            <Handle
              key={`source-${edge.target}-${index}`}
              id={`source-${edge.target}`} // 使用目标节点ID作为handle ID
              type="source"
              position={Position.Right}
              style={{
                background: 'transparent',
                width: '0px',
                height: '0px',
                border: 'none',
                opacity: 0,
                top: offsetY ? `${50 + (offsetY / 10)}%` : '50%', // 设置垂直位置，使用百分比
              }}
            />
          );
        })
      ) : (
        // 如果没有子节点，创建一个默认的连接点（用于新连接）
        <Handle
          type="source"
          position={Position.Right}
          style={{
            background: 'transparent',
            width: '0px',
            height: '0px',
            border: 'none',
            opacity: 0,
          }}
        />
      )}

      {/* 展开/折叠小点 - 只在有子节点时显示 */}
      {hasChildren && (
        <div
          onClick={(e) => {
            e.stopPropagation(); // 阻止事件冒泡，避免触发节点选择
            if (data.onToggleExpand) {
              data.onToggleExpand(id);
            }
          }}
          onMouseDown={(e) => {
            e.stopPropagation(); // 阻止事件冒泡
          }}
          style={{
            position: 'absolute',
            right: '-10px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            background: expanded ? '#4caf50' : '#999', // 展开时绿色，折叠时灰色
            border: expanded ? '1px solid #2e7d32' : 'none', // 展开时添加深绿色边框
            cursor: 'pointer', // 始终显示为可点击
            zIndex: 10,
            transition: 'all 0.2s ease', // 添加过渡效果
            boxShadow: expanded 
              ? '0 0 4px rgba(76, 175, 80, 0.5)' // 展开时添加绿色阴影
              : 'none',
          }}
          title={expanded ? '折叠子节点' : '展开子节点'}
        />
      )}

      {/* 加号按钮 - 只在节点被选中时显示 */}
      {selected && (
        <>
          {/* 加号按钮 - 节点右方：创建子节点（如果没有子节点才显示） */}
          {!hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (data.onAddChild) {
                  data.onAddChild(id);
                }
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                right: '-20px',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                border: '2px solid #4caf50',
                background: '#fff',
                color: '#4caf50',
                cursor: 'pointer',
                fontSize: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: '1',
                zIndex: 10,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
              }}
              title="添加子节点"
            >
              +
            </button>
          )}

          {/* 加号按钮 - 节点下方：创建兄弟节点（根节点不显示） */}
          {!data.isRootNode && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (data.onAddSibling) {
                  data.onAddSibling(id);
                }
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                bottom: '-20px',
                left: '50%',
                transform: 'translateX(-50%)',
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                border: '2px solid #ff9800',
                background: '#fff',
                color: '#ff9800',
                cursor: 'pointer',
                fontSize: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: '1',
                zIndex: 10,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
              }}
              title="添加兄弟节点"
            >
              +
            </button>
          )}
        </>
      )}
      
      {/* 卡片数量显示 - 只在有卡片时显示 */}
      {cardCount > 0 && !isNewNode && (
        <>
          <div
            ref={cardCountRef}
            onClick={handleCardCountClick}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: '-8px',
              right: '-8px',
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: '#fff',
              fontSize: '12px',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 20,
              boxShadow: '0 2px 8px rgba(102, 126, 234, 0.4), 0 0 12px rgba(102, 126, 234, 0.6)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.1)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.6), 0 0 16px rgba(102, 126, 234, 0.8)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.4), 0 0 12px rgba(102, 126, 234, 0.6)';
            }}
            title={`${cardCount} 张卡片，点击查看`}
          >
            {cardCount}
          </div>
          
          {/* 卡片列表悬浮窗 */}
          {showCardPopup && (
            <div
              ref={cardPopupRef}
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '400px',
                maxHeight: '500px',
                background: '#fff',
                borderRadius: '12px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* 悬浮窗标题 */}
              <div
                style={{
                  padding: '16px 20px',
                  borderBottom: '1px solid #e0e0e0',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#f5f5f5',
                }}
              >
                <div style={{ fontWeight: 'bold', fontSize: '16px', color: '#333' }}>
                  卡片列表 ({cardCount})
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowCardPopup(false);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: '20px',
                    cursor: 'pointer',
                    color: '#999',
                    padding: '0',
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="关闭"
                >
                  ×
                </button>
              </div>
              
              {/* 卡片列表 - 可滚动 */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '8px 0',
                }}
              >
                {cards.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                    暂无卡片
                  </div>
                ) : (
                  cards.map((card, index) => (
                    <div
                      key={card.docId || index}
                      onClick={() => handleCardClick(card)}
                      style={{
                        padding: '12px 20px',
                        cursor: 'pointer',
                        borderBottom: index < cards.length - 1 ? '1px solid #f0f0f0' : 'none',
                        transition: 'background-color 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = '#f5f5f5';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      <div style={{ 
                        fontSize: '14px', 
                        color: '#333',
                        fontWeight: '500',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {card.title || '未命名卡片'}
                      </div>
                      {card.updateAt && (
                        <div style={{ 
                          fontSize: '12px', 
                          color: '#999',
                          marginTop: '4px',
                        }}>
                          {new Date(card.updateAt).toLocaleDateString('zh-CN')}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// Card 接口
interface Card {
  docId: string;
  cid: number;
  title: string;
  content: string;
  updateAt: string;
  createdAt?: string;
}

// 悬浮工具栏组件
const FloatingToolbar = ({ 
  node, 
  reactFlowInstance, 
  onDelete, 
  onUpdateFontSize, 
  onUpdateColor, 
  onCopy,
  onManageCards,
  onEdit
}: { 
  node: Node; 
  reactFlowInstance: ReactFlowInstance | null;
  onDelete: (nodeId: string) => void;
  onUpdateFontSize: (nodeId: string, fontSize: number) => void;
  onUpdateColor: (nodeId: string, color: string) => void;
  onCopy: (text: string) => void;
  onManageCards: (nodeId: string) => void;
  onEdit: (node: Node) => void;
}) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!reactFlowInstance || !node) return;

    const updatePosition = () => {
      if (!reactFlowInstance || !node) return;

      // 获取节点元素的实际尺寸和位置
      const nodeElement = document.querySelector(`[data-id="${node.id}"]`) as HTMLElement;
      if (!nodeElement) return;

      const rect = nodeElement.getBoundingClientRect();
      const toolbarWidth = toolbarRef.current?.offsetWidth || 0;

      // 工具栏居中显示在节点上方
      const x = rect.left + rect.width / 2 - toolbarWidth / 2;
      const y = rect.top - 50;

      setPosition({ x, y });
    };

    // 使用 requestAnimationFrame 确保平滑更新，特别是在拖动时
    const animate = () => {
      updatePosition();
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    // 立即更新一次
    updatePosition();
    
    // 开始动画循环
    animationFrameRef.current = requestAnimationFrame(animate);

    // 监听窗口大小变化
    window.addEventListener('resize', updatePosition);
    
    // 监听节点元素的 transform 变化（拖动时会改变）
    const nodePositionObserver = new MutationObserver(() => {
      updatePosition();
    });
    
    const nodeElement = document.querySelector(`[data-id="${node.id}"]`);
    if (nodeElement) {
      // 监听节点的 style 属性变化（包括 transform）
      nodePositionObserver.observe(nodeElement, {
        attributes: true,
        attributeFilter: ['style', 'transform', 'class'],
        childList: false,
        subtree: false,
      });
      
      // 也监听父容器（ReactFlow 的 viewport 变化会影响所有节点）
      const reactFlowPane = nodeElement.closest('.react-flow');
      if (reactFlowPane) {
        nodePositionObserver.observe(reactFlowPane, {
          attributes: true,
          attributeFilter: ['style', 'transform'],
          childList: false,
          subtree: false,
        });
      }
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      window.removeEventListener('resize', updatePosition);
      nodePositionObserver.disconnect();
    };
  }, [node, reactFlowInstance]);

  if (!node) return null;

  const originalNode = node.data.originalNode as MindMapNode;
  const currentFontSize = originalNode?.fontSize || 14;
  const currentColor = originalNode?.color || '#333';

  return (
    <div
      ref={toolbarRef}
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        background: '#fff',
        border: '1px solid #ddd',
        borderRadius: '8px',
        padding: '8px',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 编辑按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onEdit(node);
        }}
        style={{
          padding: '6px 10px',
          border: '1px solid #ff9800',
          borderRadius: '4px',
          background: '#fff',
          color: '#ff9800',
          cursor: 'pointer',
          fontSize: '12px',
        }}
        title="编辑节点"
      >
        编辑
      </button>

      {/* 删除按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(node.id);
        }}
        style={{
          padding: '6px 10px',
          border: '1px solid #f44336',
          borderRadius: '4px',
          background: '#fff',
          color: '#f44336',
          cursor: 'pointer',
          fontSize: '12px',
        }}
        title="删除节点"
      >
        删除
      </button>

      {/* 字体大小 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (currentFontSize > 10) {
              onUpdateFontSize(node.id, currentFontSize - 1);
            }
          }}
          style={{
            padding: '4px 8px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            cursor: currentFontSize > 10 ? 'pointer' : 'not-allowed',
            fontSize: '12px',
            opacity: currentFontSize > 10 ? 1 : 0.5,
          }}
          disabled={currentFontSize <= 10}
        >
          A-
        </button>
        <span style={{ fontSize: '12px', minWidth: '30px', textAlign: 'center' }}>
          {currentFontSize}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (currentFontSize < 24) {
              onUpdateFontSize(node.id, currentFontSize + 1);
            }
          }}
          style={{
            padding: '4px 8px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            cursor: currentFontSize < 24 ? 'pointer' : 'not-allowed',
            fontSize: '12px',
            opacity: currentFontSize < 24 ? 1 : 0.5,
          }}
          disabled={currentFontSize >= 24}
        >
          A+
        </button>
      </div>

      {/* 字体颜色 */}
      <input
        type="color"
        value={currentColor}
        onChange={(e) => {
          e.stopPropagation();
          onUpdateColor(node.id, e.target.value);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '32px',
          height: '32px',
          border: '1px solid #ddd',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
        title="字体颜色"
      />

      {/* 复制按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCopy(originalNode?.text || '');
        }}
        style={{
          padding: '6px 10px',
          border: '1px solid #2196f3',
          borderRadius: '4px',
          background: '#fff',
          color: '#2196f3',
          cursor: 'pointer',
          fontSize: '12px',
        }}
        title="复制节点内容"
      >
        复制
      </button>

      {/* 管理卡片按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onManageCards(node.id);
        }}
        style={{
          padding: '6px 10px',
          border: '1px solid #4caf50',
          borderRadius: '4px',
          background: '#fff',
          color: '#4caf50',
          cursor: 'pointer',
          fontSize: '12px',
        }}
        title="查看卡片列表"
      >
        卡片
      </button>
    </div>
  );
};

// 自定义边缘组件：根据节点是否为新建节点显示虚线或实线，虚线按照曲度生成
const CustomMindMapEdge = ({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data, markerEnd, markerStart }: EdgeProps) => {
  // 从边缘的 data 中获取源节点和目标节点的 isNewNode 状态
  const sourceIsNewNode = data?.sourceIsNewNode as boolean | undefined;
  const targetIsNewNode = data?.targetIsNewNode as boolean | undefined;
  
  // 如果源节点或目标节点是新建节点（未保存），显示虚线；否则显示实线
  const isNewNode = sourceIsNewNode || targetIsNewNode;
  
  // 生成贝塞尔曲线路径，使用与 ReactFlow 默认 'bezier' 类型完全相同的参数
  // 确保虚线和实线使用完全相同的路径，只是样式不同
  // getBezierPath 会自动计算曲度，确保与默认 'bezier' 类型一致
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition || Position.Right,
    targetPosition: targetPosition || Position.Left,
  });
  
  // 如果连接的是新建节点，显示虚线；保存后显示实线
  // strokeDasharray 会沿着路径（包括曲线）正确分布，确保虚线和实线具有相同的曲度
  const edgeStyle = {
    ...style,
    strokeDasharray: isNewNode ? '5,5' : 'none',
  };

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={edgeStyle}
      markerEnd={markerEnd}
      markerStart={markerStart}
    />
  );
};

const customNodeTypes: NodeTypes = {
  mindmap: MindMapNodeComponent,
};

const customEdgeTypes: EdgeTypes = {
  custom: CustomMindMapEdge,
};

// 使用 dagre 自动布局
const getLayoutedElements = (nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'LR') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ 
    rankdir: direction,
    nodesep: 100,
    ranksep: 150,
    marginx: 50,
    marginy: 50,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 150, height: 80 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 75,
        y: nodeWithPosition.y - 40,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

// 大纲视图组件
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

      return (
        <div key={nodeId} style={{ position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: `${level * 24}px`, position: 'relative' }}>
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
            </div>
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
    [buildTree, selectedNodeId, onToggleExpand, onNodeClick]
  );

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: '24px 32px',
        backgroundColor: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
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

function MindMapEditor({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  const [mindMap, setMindMap] = useState<MindMapDoc>(initialData);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const isDraggingRef = useRef(false);
  const layoutTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [autoLayout, setAutoLayout] = useState(true);
  const [isImmersive, setIsImmersive] = useState(false); // 沉浸模式状态
  const autoLayoutEnabledRef = useRef(true);

  // 监听 ESC 键退出沉浸模式
  useEffect(() => {
    if (!isImmersive) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsImmersive(false);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isImmersive]);
  const [viewMode, setViewMode] = useState<'mindmap' | 'outline' | 'study' | 'yaml'>('mindmap');
  const [studyLayer, setStudyLayer] = useState<number>(0); // 当前刷题的层数
  const [studyCardIndex, setStudyCardIndex] = useState<number>(0); // 当前卡片索引
  const [isCardFlipped, setIsCardFlipped] = useState<boolean>(false); // 卡片是否翻转
  // 处理卡片管理：跳转到卡片列表页面
  const handleManageCards = useCallback((nodeId: string) => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = mindMap.currentBranch || 'main';
    const url = docId 
      ? `/d/${domainId}/mindmap/${docId}/branch/${branch}/node/${nodeId}/cards`
      : `/d/${domainId}/mindmap/mmid/${mindMap.mmid}/branch/${branch}/node/${nodeId}/cards`;
    window.open(url, '_blank');
  }, [docId, mindMap.mmid, mindMap.currentBranch]);
  const [gitStatus, setGitStatus] = useState<any>(null); // Git 状态
  const [gitStatusLoading, setGitStatusLoading] = useState(false); // Git 状态加载中
  const [history, setHistory] = useState<any[]>([]); // 操作历史记录
  const [historyLoading, setHistoryLoading] = useState(false); // 历史记录加载中
  const lastOperationRef = useRef<string>(''); // 记录最后一次操作类型

  // 使用 ref 存储回调函数，避免在依赖数组中引起无限循环
  const callbacksRef = useRef<{
    onEdit: (node: Node) => void;
    onAddChild: (nodeId: string) => void;
    onAddSibling: (nodeId: string) => void;
    onDelete: (nodeId: string) => void;
    onToggleExpand: (nodeId: string) => void;
  } | null>(null);

  // 先定义状态，因为 handleDeleteNode 需要用到它们
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // 使用 ref 存储最新的节点和边状态，确保保存时获取最新数据
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  // 同步 ref 和 state
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // 自动保存的防抖定时器
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 保存思维导图
  // isAutoSave: 是否为自动保存，自动保存时不显示成功提示
  const handleSave = useCallback(async (isAutoSave: boolean = false) => {
    setIsSaving(true);
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
        
        // 调试信息
        if (x === 0 && y === 0 && node.position.x !== 0 && node.position.y !== 0) {
          console.warn('节点位置被重置为 (0,0):', node.id, '原始位置:', node.position.x, node.position.y);
        }
        
        return updatedNode;
      });

      // 收集所有连接
      const updatedEdges = currentEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        color: (edge.style as any)?.stroke,
        width: (edge.style as any)?.strokeWidth,
      }));

      // 获取当前视口状态
      const viewport = reactFlowInstance?.getViewport();

      console.log('保存节点数据:', updatedNodes.map(n => ({ 
        id: n.id, 
        x: n.x, 
        y: n.y, 
        xType: typeof n.x, 
        yType: typeof n.y,
        xValid: typeof n.x === 'number' && !isNaN(n.x),
        yValid: typeof n.y === 'number' && !isNaN(n.y)
      })));

      // 生成操作描述
      const operationDescription = lastOperationRef.current || '自动保存';
      
      const response = await request.post(getMindMapUrl('/save', docId), {
        nodes: updatedNodes,
        edges: updatedEdges,
        viewport: viewport ? {
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        } : undefined,
        operationDescription,
      });
      
      // 保存后刷新历史记录和 Git 状态
      if (response.hasNonPositionChanges) {
        loadHistory();
        // 如果有非位置改变，立即刷新 Git 状态（因为后端已经同步到 git）
        if (mindMap.githubRepo) {
          // 延迟一点时间，确保后端同步完成，然后刷新 Git 状态
          // 使用多次重试，确保能获取到最新的状态
          const retryLoadGitStatus = async (retries = 3) => {
            for (let i = 0; i < retries; i++) {
              await new Promise(resolve => setTimeout(resolve, 500 + i * 300));
              try {
                const branch = mindMap.currentBranch || 'main';
                const domainId = (window as any).UiContext?.domainId || 'system';
                const statusResponse = await request.get(`${getMindMapUrl('/git/status', docId)}?branch=${branch}`);
                const newGitStatus = statusResponse.gitStatus;
                setGitStatus(newGitStatus);
                // 如果检测到有未提交的更改，说明同步成功，可以停止重试
                if (newGitStatus?.uncommittedChanges) {
                  break;
                }
              } catch (err) {
                console.error('Failed to load git status:', err);
              }
            }
          };
          retryLoadGitStatus();
        }
      } else if (mindMap.githubRepo) {
        // 即使只有位置改变，也刷新一下 Git 状态（虽然可能没有变化）
        loadGitStatus();
      }
      
      // 重置操作描述
      lastOperationRef.current = '';

      // 只有手动保存时才显示成功提示
      if (!isAutoSave) {
        Notification.success('思维导图已保存');
      }
      console.log('保存成功，节点数据:', updatedNodes.map(n => ({ id: n.id, x: n.x, y: n.y })));
      setIsSaving(false);
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
      setIsSaving(false);
    }
  }, [docId, reactFlowInstance]);

  // 从 YAML 保存的函数（支持卡片）
  const handleSaveFromYaml = useCallback(async (newNodes: MindMapNode[], newEdges: MindMapEdge[], cardsData?: Array<{ nodeId: string; cards: Card[] }>) => {
    setIsSaving(true);
    try {
      // 合并新节点和现有节点
      const existingNodeIds = new Set(nodesRef.current.map(n => n.id));
      const updatedNodes = newNodes.map((node) => {
        // 如果节点已存在，保留位置信息
        if (existingNodeIds.has(node.id)) {
          const existingNode = nodesRef.current.find(n => n.id === node.id);
          if (existingNode) {
            const originalNode = existingNode.data.originalNode as MindMapNode;
            return {
              ...node,
              x: originalNode.x || node.x || 0,
              y: originalNode.y || node.y || 0,
            };
          }
        }
        return {
          ...node,
          x: node.x || 0,
          y: node.y || 0,
        };
      });

      // 合并新边和现有边
      const existingEdgeIds = new Set(edgesRef.current.map(e => e.id));
      const updatedEdges = newEdges.map((edge) => {
        const existingEdge = edgesRef.current.find(e => e.id === edge.id);
        if (existingEdge) {
          return {
            ...edge,
            label: edge.label || existingEdge.label,
            color: edge.color || (existingEdge.style as any)?.stroke,
            width: edge.width || (existingEdge.style as any)?.strokeWidth,
          };
        }
        return edge;
      });

      // 获取当前视口状态
      const viewport = reactFlowInstance?.getViewport();

      // 生成操作描述
      lastOperationRef.current = 'YAML 模式保存';
      
      const response = await request.post(getMindMapUrl('/save', docId), {
        nodes: updatedNodes,
        edges: updatedEdges,
        viewport: viewport ? {
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        } : undefined,
        operationDescription: 'YAML 模式保存',
      });
      
      // 保存后刷新历史记录和 Git 状态
      if (response.hasNonPositionChanges) {
        // 延迟加载历史记录，避免在函数定义之前调用
        setTimeout(() => {
          const domainId = (window as any).UiContext?.domainId || 'system';
          request.get(getMindMapUrl('/history', docId)).then((response) => {
            setHistory(response.history || []);
          }).catch((error) => {
            console.error('Failed to load history:', error);
          });
        }, 100);
        
        if (mindMap.githubRepo) {
          const retryLoadGitStatus = async (retries = 3) => {
            for (let i = 0; i < retries; i++) {
              await new Promise(resolve => setTimeout(resolve, 500 + i * 300));
              try {
                const branch = mindMap.currentBranch || 'main';
                const domainId = (window as any).UiContext?.domainId || 'system';
                const statusResponse = await request.get(`${getMindMapUrl('/git/status', docId)}?branch=${branch}`);
                const newGitStatus = statusResponse.gitStatus;
                setGitStatus(newGitStatus);
                if (newGitStatus?.uncommittedChanges) {
                  break;
                }
              } catch (err) {
                console.error('Failed to load git status:', err);
              }
            }
          };
          retryLoadGitStatus();
        }
      } else if (mindMap.githubRepo) {
        setTimeout(() => {
          const branch = mindMap.currentBranch || 'main';
          const domainId = (window as any).UiContext?.domainId || 'system';
          request.get(`${getMindMapUrl('/git/status', docId)}?branch=${branch}`).then((response) => {
            setGitStatus(response.gitStatus);
          }).catch((error) => {
            console.error('Failed to load git status:', error);
          });
        }, 100);
      }
      
      const cardOperationErrors: string[] = [];

      // 处理卡片数据
      if (cardsData && cardsData.length > 0) {
        const domainId = (window as any).UiContext?.domainId || 'system';
        const mmid = mindMap.mmid;
        
        for (const nodeCardData of cardsData) {
          const { nodeId, cards } = nodeCardData;
          const existingCards = ((window as any).UiContext?.nodeCardsMap?.[nodeId] || []).slice().sort(
            (a, b) => (a.cid || 0) - (b.cid || 0)
          );
          const existingCardsByCid = new Map<number, Card>();
          existingCards.forEach(card => {
            if (typeof card.cid === 'number') {
              existingCardsByCid.set(card.cid, card);
            }
          });
          const desiredCards = cards.map((card, index) => ({
            cid: index + 1,
            title: card.title || '',
            content: card.content || '',
          }));

          const processedCids = new Set<number>();

          for (let index = 0; index < desiredCards.length; index++) {
            const desiredCard = desiredCards[index];
            processedCids.add(desiredCard.cid);

            const matchedCard =
              existingCardsByCid.get(desiredCard.cid) ||
              existingCards[index];

            if (matchedCard && matchedCard.docId) {
              try {
                await request.post(`/d/${domainId}/mindmap/card/${matchedCard.docId}`, {
                  operation: 'update',
                  nodeId,
                  mmid,
                  cid: desiredCard.cid,
                  title: desiredCard.title,
                  content: desiredCard.content,
                  order: index + 1,
                });
              } catch (error: any) {
                console.error(`Failed to update card ${matchedCard.docId}:`, error);
                cardOperationErrors.push(`更新卡片「${desiredCard.title || matchedCard.docId}」失败: ${error?.message || '未知错误'}`);
              }
            } else {
              try {
                const createResponse = await request.post(`/d/${domainId}/mindmap/mmid/${mmid}/card`, {
                  nodeId,
                  title: desiredCard.title,
                  content: desiredCard.content,
                });
                const newCardId = createResponse?.cardId;
                if (newCardId) {
                  await request.post(`/d/${domainId}/mindmap/card/${newCardId}`, {
                    operation: 'update',
                    order: index + 1,
                  });
                }
              } catch (createErr: any) {
                console.error(`Failed to sync card ${desiredCard.cid} for node ${nodeId}:`, createErr);
                cardOperationErrors.push(`同步卡片「${desiredCard.title || ''}」失败: ${createErr?.message || '未知错误'}`);
              }
            }
          }

          for (const existingCard of existingCards) {
            if (!processedCids.has(existingCard.cid) && (existingCard.docId || existingCard.cid)) {
              const identifier = existingCard.docId || String(existingCard.cid);
              try {
                await request.post(`/d/${domainId}/mindmap/card/${identifier}`, {
                  operation: 'delete',
                  nodeId,
                  mmid,
                  cid: existingCard.cid,
                });
              } catch (error: any) {
                console.error(`Failed to delete card ${identifier}:`, error);
                cardOperationErrors.push(`删除卡片「${existingCard.title || identifier}」失败: ${error?.message || '未知错误'}`);
              }
            }
          }
        }
      }

      if (cardOperationErrors.length > 0) {
        throw new Error(cardOperationErrors.join('\n'));
      }
      
      // 重置操作描述
      lastOperationRef.current = '';

      // 重新加载数据以更新节点和边
      const domainId = (window as any).UiContext?.domainId || 'system';
      const responseData = await request.get(getMindMapUrl('/data', docId));
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
      
      Notification.success('YAML 保存成功');
      setIsSaving(false);
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
      setIsSaving(false);
    }
  }, [docId, reactFlowInstance, mindMap.githubRepo, mindMap.currentBranch]);

  // 加载 Git 状态
  const loadGitStatus = useCallback(async () => {
    if (!mindMap.githubRepo) return;
    
    setGitStatusLoading(true);
    try {
      const branch = mindMap.currentBranch || 'main';
      const domainId = (window as any).UiContext?.domainId || 'system';
      const response = await request.get(`${getMindMapUrl('/git/status', docId)}?branch=${branch}`);
      setGitStatus(response.gitStatus);
    } catch (error: any) {
      console.error('Failed to load git status:', error);
      setGitStatus(null);
    } finally {
      setGitStatusLoading(false);
    }
  }, [docId, mindMap.githubRepo, mindMap.currentBranch]);

  // 加载历史记录
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      const response = await request.get(getMindMapUrl('/history', docId));
      setHistory(response.history || []);
    } catch (error: any) {
      console.error('Failed to load history:', error);
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [docId]);

  // 恢复到历史节点
  const restoreHistory = useCallback(async (historyId: string) => {
    if (!confirm('确定要恢复到该历史节点吗？当前未保存的更改将丢失。')) return;
    
    try {
      await request.post(getMindMapUrl(`/history/${historyId}/restore`, docId));
      Notification.success('恢复成功，页面将刷新');
      setTimeout(() => window.location.reload(), 1000);
    } catch (error: any) {
      Notification.error('恢复失败: ' + (error.message || '未知错误'));
    }
  }, [docId]);

  // 触发自动保存（带防抖）
  // 每次调用都会清除之前的定时器并重新开始计时
  // 只有在1秒内完全没有操作时才会真正保存
  const triggerAutoSave = useCallback(() => {
    // 清除之前的定时器（如果有）
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      console.log('1.5秒内无操作，触发自动保存');
      handleSave(true); // 传入 true 表示自动保存，不显示成功提示
      saveTimerRef.current = null;
      // 注意：Git 状态和历史记录的刷新已经在 handleSave 中处理了
    }, 1500);
  }, [handleSave, mindMap.githubRepo, loadGitStatus, loadHistory]);

  useEffect(() => {
    let ws: any = null;
    const domainId = (window as any).UiContext?.domainId || 'system';
    const wsUrl = `/d/${domainId}/mindmap/${docId}/ws`;

    // 初始加载
    loadHistory();
    if (mindMap.githubRepo) {
      loadGitStatus();
    }

    // 连接 WebSocket 的函数
    const connectWebSocket = () => {
      import('../components/socket').then(({ default: WebSocket }) => {
        ws = new WebSocket(wsUrl, false, true);

        ws.onopen = () => {
          console.log('[MindMap] WebSocket connected');
        };

        ws.onmessage = (_: any, data: string) => {
          try {
            const msg = JSON.parse(data);
            console.log('[MindMap] WebSocket message:', msg);

            if (msg.type === 'init' || msg.type === 'update') {
              // 更新 git status 和 history
              if (msg.gitStatus !== undefined) {
                setGitStatus(msg.gitStatus);
              }
              if (msg.history !== undefined) {
                setHistory(msg.history);
              }
            } else if (msg.type === 'git_status') {
              // 只更新 git status
              if (msg.gitStatus !== undefined) {
                setGitStatus(msg.gitStatus);
              }
            } else if (msg.type === 'history') {
              // 只更新 history
              if (msg.history !== undefined) {
                setHistory(msg.history);
              }
            }
          } catch (error) {
            console.error('[MindMap] Failed to parse WebSocket message:', error);
          }
        };

        ws.onclose = () => {
          console.log('[MindMap] WebSocket closed');
          ws = null;
        };

        ws.onerror = (error: any) => {
          console.error('[MindMap] WebSocket error:', error);
        };
      }).catch((error) => {
        console.error('[MindMap] Failed to load WebSocket:', error);
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
  }, [docId, mindMap.githubRepo, loadHistory, loadGitStatus]);

  // 包装 onEdgesChange 以在边变化时触发自动保存（特别是删除边）
  const handleEdgesChange = useCallback((changes: any) => {
    onEdgesChange(changes);
    // 检查是否有删除边的操作
    const hasDeletion = changes.some((change: any) => change.type === 'remove');
    if (hasDeletion) {
      triggerAutoSave();
    }
  }, [onEdgesChange, triggerAutoSave]);

  // 手动触发布局函数
  const applyLayout = useCallback(() => {
    if (!autoLayout || !autoLayoutEnabledRef.current || isDraggingRef.current) {
      return;
    }
    
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
    }
    
    layoutTimeoutRef.current = setTimeout(() => {
      if (!isDraggingRef.current && autoLayoutEnabledRef.current) {
        // 使用 ref 获取最新的节点和边数据，确保布局计算时数据完整
        const currentNodes = nodesRef.current || [];
        const currentEdges = edgesRef.current || [];
        
        if (currentNodes.length === 0 || currentEdges.length === 0) {
          return;
        }
        
        const { nodes: layoutedNodes } = getLayoutedElements(currentNodes, currentEdges);
        
        // 计算新的节点数组，同时更新 originalNode 位置
        const updatedNodes = currentNodes.map((n) => {
          const layoutedNode = layoutedNodes.find(ln => ln.id === n.id);
          if (layoutedNode) {
            const originalNode = n.data.originalNode as MindMapNode;
            return {
              ...n,
              position: layoutedNode.position,
              data: {
                ...n.data,
                originalNode: originalNode ? {
                  ...originalNode,
                  x: layoutedNode.position.x,
                  y: layoutedNode.position.y,
                } : originalNode,
              },
            };
          }
          return n;
        });
        
        // 更新状态和 ref
        setNodes(updatedNodes);
        nodesRef.current = updatedNodes;
      }
    }, 300);
  }, [autoLayout, setNodes]);

  // 删除节点 - 必须在 useMemo 之前定义
  const handleDeleteNode = useCallback(async (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const isNewNode = node.data.isNewNode || false;
    
    // 如果是新建节点（临时节点），直接从前端删除，不调用后端API
    if (isNewNode) {
      // 删除临时节点和临时边
      const tempEdgeId = node.data.tempEdgeId;
      
      // 更新节点和边的状态
      setNodes((nds) => {
        const updatedNodes = nds.filter((n) => n.id !== nodeId);
        // 更新 ref，确保自动布局使用最新数据
        nodesRef.current = updatedNodes;
        return updatedNodes;
      });
      
      if (tempEdgeId) {
        setEdges((eds) => {
          const updatedEdges = eds.filter((e) => e.id !== tempEdgeId);
          // 更新 ref，确保自动布局使用最新数据
          edgesRef.current = updatedEdges;
          return updatedEdges;
        });
      } else {
        // 即使没有临时边，也要更新 edgesRef
        edgesRef.current = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
      }
      
      // 删除新建节点后，如果自动布局开启，触发布局以恢复到之前的间距
      if (autoLayout) {
        setTimeout(() => {
          applyLayout();
        }, 100);
      }
      
      return;
    }

    // 如果是已保存的节点，需要确认并调用后端API删除
    if (!confirm('确定要删除这个节点吗？')) {
      return;
    }

    try {
      const nodeText = node?.data?.originalNode?.text || '节点';
      lastOperationRef.current = `删除节点: ${nodeText}`;

      await request.post(getMindMapUrl(`/node/${nodeId}`, docId), {
        operation: 'delete',
      });

      // 从本地状态中移除
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));

      Notification.success('节点已删除');
      
      // 删除节点后，如果自动布局开启，触发布局
      if (autoLayout) {
        setTimeout(() => {
          applyLayout();
        }, 100);
      }
      
      // 触发自动保存
      triggerAutoSave();
      
      // 立即刷新Git状态
      if (mindMap.githubRepo) {
        setTimeout(() => {
          loadGitStatus();
        }, 1000);
      }
    } catch (error: any) {
      Notification.error('删除节点失败: ' + (error.message || '未知错误'));
    }
  }, [docId, nodes, setNodes, setEdges, autoLayout, applyLayout, triggerAutoSave]);

  // 编辑节点 - 直接进入编辑模式
  const handleEditNode = useCallback((node: Node) => {
    const originalNode = node.data.originalNode as MindMapNode;
    if (!originalNode) return;

    // 直接进入编辑模式，不弹出对话框
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === node.id) {
          return {
            ...n,
            data: {
              ...n.data,
              isEditing: true,
            },
          };
        }
        return n;
      })
    );
  }, [setNodes]);

  // 旧的编辑节点函数（保留但不再使用，以防需要）
  const handleEditNodeOld = useCallback(async (node: Node) => {
    const originalNode = node.data.originalNode as MindMapNode;
    if (!originalNode) return;

    try {
      const result = await new Promise<{ text: string; color?: string; backgroundColor?: string; fontSize?: number } | null>((resolve) => {
        const $body = $(
          `<div>
            <div style="margin-bottom: 15px;">
              <label>
                节点文本:
                <input type="text" name="text" class="textbox" value="${(originalNode.text || '').replace(/"/g, '&quot;')}" style="width: 100%;" required />
              </label>
            </div>
            <div style="margin-bottom: 15px;">
              <label>
                文字颜色:
                <input type="color" name="color" value="${originalNode.color || '#333333'}" style="width: 100%;" />
              </label>
            </div>
            <div style="margin-bottom: 15px;">
              <label>
                背景颜色:
                <input type="color" name="backgroundColor" value="${originalNode.backgroundColor || '#ffffff'}" style="width: 100%;" />
              </label>
            </div>
            <div style="margin-bottom: 15px;">
              <label>
                字体大小:
                <input type="number" name="fontSize" value="${originalNode.fontSize || 14}" min="10" max="24" style="width: 100%;" />
              </label>
            </div>
          </div>`
        );

        const dialog = new ActionDialog({
          $body,
          width: '400px',
        } as any);

        dialog.open().then((action) => {
          if (action === 'ok') {
            const text = $body.find('input[name="text"]').val() as string;
            const color = $body.find('input[name="color"]').val() as string;
            const backgroundColor = $body.find('input[name="backgroundColor"]').val() as string;
            const fontSize = parseInt($body.find('input[name="fontSize"]').val() as string, 10);
            resolve({ text, color, backgroundColor, fontSize });
          } else {
            resolve(null);
          }
        });
      });

      if (result) {
        lastOperationRef.current = `编辑节点: ${result.text}`;
        
        await request.post(getMindMapUrl(`/node/${originalNode.id}`, docId), {
          operation: 'update',
          ...result,
        });

        // 更新本地状态
        setNodes((nds) =>
          nds.map((n) =>
            n.id === node.id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    originalNode: {
                      ...originalNode,
                      ...result,
                    },
                  },
                }
              : n
          )
        );

        Notification.success('节点已更新');
        // 触发自动保存
        triggerAutoSave();
        
        // 立即刷新Git状态
        if (mindMap.githubRepo) {
          setTimeout(() => {
            loadGitStatus();
          }, 1000);
        }
      }
    } catch (error: any) {
      Notification.error('更新节点失败: ' + (error.message || '未知错误'));
    }
  }, [docId, setNodes, triggerAutoSave, mindMap.githubRepo, loadGitStatus]);

  // 更新节点字体大小
  const handleUpdateFontSize = useCallback(async (nodeId: string, fontSize: number) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const originalNode = node.data.originalNode as MindMapNode;
    if (!originalNode) return;

    try {
      lastOperationRef.current = `修改字体大小: ${originalNode.text}`;
      
      await request.post(getMindMapUrl(`/node/${originalNode.id}`, docId), {
        operation: 'update',
        fontSize,
      });

      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  originalNode: {
                    ...originalNode,
                    fontSize,
                  },
                },
              }
            : n
        )
      );

      triggerAutoSave();
      
      // 立即刷新Git状态
      if (mindMap.githubRepo) {
        setTimeout(() => {
          loadGitStatus();
        }, 1000);
      }
    } catch (error: any) {
      Notification.error('更新字体大小失败: ' + (error.message || '未知错误'));
    }
  }, [docId, nodes, setNodes, triggerAutoSave, mindMap.githubRepo, loadGitStatus]);

  // 更新节点字体颜色
  const handleUpdateColor = useCallback(async (nodeId: string, color: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const originalNode = node.data.originalNode as MindMapNode;
    if (!originalNode) return;

    try {
      lastOperationRef.current = `修改颜色: ${originalNode.text}`;
      
      await request.post(getMindMapUrl(`/node/${originalNode.id}`, docId), {
        operation: 'update',
        color,
      });

      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  originalNode: {
                    ...originalNode,
                    color,
                  },
                },
              }
            : n
        )
      );

      triggerAutoSave();
      
      // 立即刷新Git状态
      if (mindMap.githubRepo) {
        setTimeout(() => {
          loadGitStatus();
        }, 1000);
      }
    } catch (error: any) {
      Notification.error('更新字体颜色失败: ' + (error.message || '未知错误'));
    }
  }, [docId, nodes, setNodes, triggerAutoSave]);

  // 切换节点展开/折叠状态（前端立即更新，后端通过自动保存）
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

  // 复制节点内容
  const handleCopyNodeContent = useCallback((text: string) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        Notification.success('已复制到剪贴板');
      }).catch(() => {
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand('copy');
          Notification.success('已复制到剪贴板');
        } catch (err) {
          Notification.error('复制失败');
        }
        document.body.removeChild(textArea);
      });
    } else {
      // 降级方案
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        Notification.success('已复制到剪贴板');
      } catch (err) {
        Notification.error('复制失败');
      }
      document.body.removeChild(textArea);
    }
  }, []);

  // 进入编辑模式（双击节点时调用）
  const handleEnterEdit = useCallback((nodeId: string) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === nodeId) {
          return {
            ...n,
            data: {
              ...n.data,
              isEditing: true,
            },
          };
        }
        return n;
      })
    );
  }, [setNodes]);

  // 退出编辑模式（双击进入编辑但未修改文本时调用）
  const handleExitEdit = useCallback((nodeId: string) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === nodeId) {
          return {
            ...n,
            data: {
              ...n.data,
              isEditing: false,
            },
          };
        }
        return n;
      })
    );
  }, [setNodes]);

  // 处理节点文本变化（失去焦点时调用）
  const handleNodeTextChange = useCallback(async (nodeId: string, newText: string) => {
    // 使用 ref 获取最新的 nodes，避免依赖 nodes 导致循环
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node) return;
    
    const isNewNode = node.data.isNewNode || false;
    const originalNode = node.data.originalNode as MindMapNode;
    
    // 如果是新节点且有文本，保存到后端
    if (isNewNode && newText.trim()) {
      try {
        const mode = (originalNode as any).mode || 'child';
        const parentId = originalNode.parentId;
        const siblingId = (originalNode as any).siblingId;
        
        const requestBody: any = {
          operation: 'add',
          text: newText.trim(),
        };

        // 如果是兄弟节点，必须传递 siblingId，且不能传递 parentId
        // 后端会根据 siblingId 找到兄弟节点的父节点，然后新节点也使用这个父节点
        if (mode === 'sibling' && siblingId) {
          // 确保 siblingId 是真实节点ID，不是临时ID
          let realSiblingId = siblingId;
          if (siblingId.startsWith('temp_')) {
            // 如果是临时ID，尝试从 nodes 中找到对应的真实节点
            const siblingNode = nodesRef.current.find(n => n.id === siblingId);
            if (siblingNode && !siblingNode.data.isNewNode) {
              // 如果节点已经保存，使用保存后的ID
              realSiblingId = siblingNode.data.originalNode.id;
            } else {
              console.error('兄弟节点是临时节点且还未保存，无法创建兄弟节点:', siblingId);
              Notification.error('兄弟节点还未保存，请先保存兄弟节点');
              return;
            }
          }
          // 只传递 siblingId，不传递 parentId，让后端自己找父节点
          requestBody.siblingId = realSiblingId;
          // 确保不传递 parentId
          console.log('创建兄弟节点，siblingId:', realSiblingId, '原始siblingId:', siblingId, '不传递parentId');
        } else if (mode === 'child' && parentId) {
          // 确保 parentId 是真实节点ID
          let realParentId = parentId;
          if (parentId.startsWith('temp_')) {
            const parentNode = nodesRef.current.find(n => n.id === parentId);
            if (parentNode && !parentNode.data.isNewNode) {
              realParentId = parentNode.data.originalNode.id;
            } else {
              console.error('父节点是临时节点且还未保存，无法创建子节点:', parentId);
              Notification.error('父节点还未保存，请先保存父节点');
              return;
            }
          }
          requestBody.parentId = realParentId;
          // 确保不传递 siblingId
        }

        const response = await request.post(getMindMapUrl('/node', docId), requestBody);
        console.log('后端返回的完整响应:', response);
        const newNodeId = response.nodeId;
        
        // 更新节点ID和状态
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === nodeId) {
              return {
                ...n,
                id: newNodeId,
                data: {
                  ...n.data,
                  originalNode: {
                    ...originalNode,
                    id: newNodeId,
                    text: newText.trim(),
                  },
                  isNewNode: false,
                  isEditing: false,
                },
              };
            }
            return n;
          })
        );

        // 更新临时边为正式边
        const tempEdgeId = node.data.tempEdgeId;
        const edgeSource = node.data.edgeSource;
        
        console.log('保存节点后的边信息:', {
          tempEdgeId,
          edgeSource,
          responseEdgeId: response.edgeId,
          responseEdgeSource: response.edgeSource,
          responseEdgeTarget: response.edgeTarget,
          nodeId,
          newNodeId,
        });
        
        if (tempEdgeId && edgeSource) {
          // 如果后端返回了边信息，使用后端的边
          if (response.edgeId && response.edgeSource && response.edgeTarget) {
            // 删除临时边
            setEdges((eds) => eds.filter((e) => e.id !== tempEdgeId));
            
            const newEdge: Edge = {
              id: response.edgeId,
              source: response.edgeSource,
              target: response.edgeTarget === nodeId ? newNodeId : response.edgeTarget,
              type: 'custom', // 使用自定义边缘类型
              animated: false,
              style: {
                stroke: '#2196f3', // 使用默认的蓝色
                strokeWidth: 2,
              },
              data: {
                // 节点状态会在 useEffect 中自动更新
              },
            };
            console.log('添加正式边:', newEdge);
            setEdges((eds) => [...eds, newEdge]);
          } else {
            // 如果后端没有返回边信息，但存在临时边，更新临时边的 target 为新节点ID
            console.warn('后端没有返回边信息，但存在临时边，更新临时边的target');
            setEdges((eds) =>
              eds.map((e) => {
                if (e.id === tempEdgeId) {
                  return {
                    ...e,
                    id: tempEdgeId, // 保持临时边ID，等待后续保存
                    target: newNodeId, // 更新target为新节点ID
                    style: {
                      stroke: '#2196f3', // 确保有正确的颜色
                      strokeWidth: 2,
                    },
                  };
                }
                return e;
              })
            );
          }
        } else if (response.edgeId && response.edgeSource && response.edgeTarget) {
          // 如果没有临时边，直接使用后端返回的边
          const newEdge: Edge = {
            id: response.edgeId,
            source: response.edgeSource,
            target: response.edgeTarget === nodeId ? newNodeId : response.edgeTarget,
            type: 'custom', // 使用自定义边缘类型
            animated: false,
            style: {
              stroke: '#2196f3', // 使用默认的蓝色
              strokeWidth: 2,
            },
            data: {
              // 节点状态会在 useEffect 中自动更新
            },
          };
          console.log('添加后端返回的边（无临时边）:', newEdge);
          setEdges((eds) => [...eds, newEdge]);
        } else {
          console.warn('没有临时边，后端也没有返回边信息');
        }
        
        // 清除节点数据中的临时边信息
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === newNodeId) {
              const { tempEdgeId: _, edgeSource: __, ...restData } = n.data;
              return {
                ...n,
                data: restData,
              };
            }
            return n;
          })
        );
        
        // 节点保存成功后，如果自动布局开启，触发布局
        if (autoLayout) {
          setTimeout(() => {
            applyLayout();
          }, 100);
        }
        
        // 触发自动保存
        triggerAutoSave();
        
        // 立即刷新Git状态（新建节点）
        if (mindMap.githubRepo) {
          setTimeout(() => {
            loadGitStatus();
          }, 1000);
        }
      } catch (error: any) {
        Notification.error('保存节点失败: ' + (error.message || '未知错误'));
      }
    } else if (!isNewNode && newText.trim() !== originalNode.text) {
      // 如果是已存在的节点，更新文本
      try {
        await request.post(getMindMapUrl(`/node/${nodeId}`, docId), {
          operation: 'update',
          text: newText.trim(),
        });
        
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === nodeId) {
              return {
                ...n,
                data: {
                  ...n.data,
                  originalNode: {
                    ...n.data.originalNode,
                    text: newText.trim(),
                  },
                  isEditing: false,
                },
              };
            }
            return n;
          })
        );
        
        triggerAutoSave();
        
        // 立即刷新Git状态（更新节点文本）
        if (mindMap.githubRepo) {
          setTimeout(() => {
            loadGitStatus();
          }, 1000);
        }
      } catch (error: any) {
        Notification.error('更新节点失败: ' + (error.message || '未知错误'));
      }
    } else if (!isNewNode && newText.trim() === originalNode.text) {
      // 如果是已存在的节点但文本没有变化，只退出编辑模式
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            return {
              ...n,
              data: {
                ...n.data,
                isEditing: false,
              },
            };
          }
          return n;
        })
      );
    } else if (isNewNode && !newText.trim()) {
      // 如果是新节点但没有文本，删除节点和临时边
      const tempEdgeId = node.data.tempEdgeId;
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      if (tempEdgeId) {
        setEdges((eds) => eds.filter((e) => e.id !== tempEdgeId));
      }
    }
  }, [docId, setNodes, setEdges, triggerAutoSave, autoLayout, applyLayout]); // 移除 nodes 依赖，使用 nodesRef 代替

  // 检查位置是否与现有节点重叠
  const checkOverlap = useCallback((pos: { x: number; y: number }, excludeId?: string): boolean => {
    const nodeWidth = 150;
    const nodeHeight = 80;
    const padding = 40;
    
    return nodes.some(node => {
      if (excludeId && node.id === excludeId) return false;
      const nodeX = node.position.x;
      const nodeY = node.position.y;
      
      return !(
        pos.x + nodeWidth + padding < nodeX ||
        pos.x > nodeX + nodeWidth + padding ||
        pos.y + nodeHeight + padding < nodeY ||
        pos.y > nodeY + nodeHeight + padding
      );
    });
  }, [nodes]);

  // 检查边的路径是否可能重叠（简化版：检查同一父节点的子节点间距）
  const checkEdgeOverlap = useCallback((
    parentId: string,
    newPos: { x: number; y: number },
    excludeId?: string
  ): boolean => {
    const minVerticalSpacing = 120;
    
    const siblings = edges
      .filter(e => e.source === parentId && e.target !== excludeId)
      .map(e => nodes.find(n => n.id === e.target))
      .filter(Boolean) as Node[];
    
    return siblings.some(sibling => {
      const verticalDistance = Math.abs(newPos.y - sibling.position.y);
      return verticalDistance < minVerticalSpacing;
    });
  }, [nodes, edges]);

  // 找到一个不重叠的位置
  const findNonOverlappingPosition = useCallback((
    startPos: { x: number; y: number },
    direction: 'right' | 'down' | 'diagonal',
    excludeId?: string
  ): { x: number; y: number } => {
    const nodeWidth = 150;
    const nodeHeight = 80;
    const padding = 20;
    const step = 30;
    
    let currentPos = { ...startPos };
    let attempts = 0;
    const maxAttempts = 50;
    
    while (checkOverlap(currentPos, excludeId) && attempts < maxAttempts) {
      attempts++;
      if (direction === 'right') {
        currentPos.x += step;
      } else if (direction === 'down') {
        currentPos.y += step;
      } else {
        currentPos.x += step;
        currentPos.y += step;
      }
    }
    
    return currentPos;
  }, [checkOverlap]);

  // 添加节点 - 必须在 useMemo 之前定义
  const handleAddNode = useCallback((parentId?: string, mode: 'child' | 'sibling' = 'child', siblingId?: string) => {
    const tempNodeId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    let position = { x: 300, y: 200 };
    
    if (mode === 'child' && parentId) {
      const parentNode = nodes.find(n => n.id === parentId);
      if (parentNode) {
        // 找到父节点的所有子节点
        const childNodes = edges
          .filter(e => e.source === parentId)
          .map(e => nodes.find(n => n.id === e.target))
          .filter(Boolean) as Node[];
        
        if (childNodes.length === 0) {
          // 第一个子节点：在父节点右侧，与父节点同一水平线
          position = findNonOverlappingPosition(
            { x: parentNode.position.x + 250, y: parentNode.position.y },
            'right',
            tempNodeId
          );
        } else {
          // 有子节点：垂直排列，确保有足够间距避免边重叠
          childNodes.sort((a, b) => a.position.y - b.position.y);
          const lastChild = childNodes[childNodes.length - 1];
          const minSpacing = 120;
          
          // 计算新位置：在最后一个子节点下方，保持最小间距
          let newY = lastChild.position.y + minSpacing;
          
          // 检查是否与边重叠
          let attempts = 0;
          while (checkEdgeOverlap(parentId, { x: lastChild.position.x, y: newY }, tempNodeId) && attempts < 10) {
            newY += 20;
            attempts++;
          }
          
          position = findNonOverlappingPosition(
            { x: lastChild.position.x, y: newY },
            'down',
            tempNodeId
          );
        }
      }
    } else if (mode === 'sibling' && siblingId) {
      const siblingNode = nodes.find(n => n.id === siblingId);
      if (siblingNode) {
        // 找到兄弟节点的父节点
        const parentEdge = edges.find(e => e.target === siblingId);
        if (parentEdge) {
          // 找到所有兄弟节点（同一个父节点的子节点）
          const siblingNodes = edges
            .filter(e => e.source === parentEdge.source && e.target !== siblingId)
            .map(e => nodes.find(n => n.id === e.target))
            .filter(Boolean) as Node[];
          
          // 找到当前兄弟节点在兄弟列表中的位置
          const allSiblings = edges
            .filter(e => e.source === parentEdge.source)
            .map(e => nodes.find(n => n.id === e.target))
            .filter(Boolean) as Node[];
          
          // 按 y 坐标排序
          allSiblings.sort((a, b) => a.position.y - b.position.y);
          const siblingIndex = allSiblings.findIndex(n => n.id === siblingId);
          
          if (siblingIndex >= 0 && siblingIndex < allSiblings.length - 1) {
            // 在当前兄弟节点和下一个兄弟节点之间插入
            const nextSibling = allSiblings[siblingIndex + 1];
            const minSpacing = 120;
            const gap = nextSibling.position.y - siblingNode.position.y;
            
            if (gap >= minSpacing * 2) {
              // 有足够空间，插入中间
              position = {
                x: siblingNode.position.x,
                y: (siblingNode.position.y + nextSibling.position.y) / 2,
              };
            } else {
              // 空间不足，放在下一个兄弟节点下方
              position = findNonOverlappingPosition(
                { x: siblingNode.position.x, y: nextSibling.position.y + minSpacing },
                'down',
                tempNodeId
              );
            }
          } else {
            // 在最后一个兄弟节点下方，确保有足够间距
            const minSpacing = 120;
            position = findNonOverlappingPosition(
              { x: siblingNode.position.x, y: siblingNode.position.y + minSpacing },
              'down',
              tempNodeId
            );
          }
        } else {
          // 根节点的兄弟节点
          position = findNonOverlappingPosition(
            { x: siblingNode.position.x, y: siblingNode.position.y + 100 },
            'down',
            tempNodeId
          );
        }
      }
    } else {
      // 根节点：找一个不重叠的位置
      position = findNonOverlappingPosition({ x: 300, y: 200 }, 'diagonal', tempNodeId);
    }

    const isRootNode = !parentId && !siblingId;
    const newFlowNode: Node = {
      id: tempNodeId,
      type: 'mindmap',
      position,
      draggable: isRootNode,
      data: {
        originalNode: {
          id: tempNodeId,
          text: '',
          x: position.x,
          y: position.y,
          mode,
          parentId,
          siblingId,
        } as any,
        isNewNode: true,
        isEditing: true,
        isRootNode,
        edges: edges,
        docId: docId, // 传递 docId 用于获取卡片
        mmid: mindMap.mmid, // 传递 mmid 用于获取卡片
        branch: mindMap.currentBranch || 'main', // 传递 branch 用于跳转
        onDelete: (nodeId: string) => callbacksRef.current?.onDelete(nodeId),
        onEdit: (node: Node) => callbacksRef.current?.onEdit(node),
        onAddChild: (nodeId: string) => callbacksRef.current?.onAddChild(nodeId),
        onAddSibling: (nodeId: string) => callbacksRef.current?.onAddSibling(nodeId),
        onToggleExpand: (nodeId: string) => callbacksRef.current?.onToggleExpand(nodeId),
        onTextChange: (nodeId: string, newText: string) => {
          handleNodeTextChangeRef.current(nodeId, newText);
        },
        onEnterEdit: (nodeId: string) => {
          handleEnterEditRef.current(nodeId);
        },
        onExitEdit: (nodeId: string) => {
          handleExitEditRef.current(nodeId);
        },
      },
    };

    setNodes((nds) => [...nds, newFlowNode]);
    
    // 创建临时边（还未保存）
    let tempEdgeId: string | undefined;
    let edgeSource: string | undefined;
    
    if (mode === 'child' && parentId) {
      // 子节点：从父节点连接到新节点
      tempEdgeId = `temp_edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      edgeSource = parentId;
      const tempEdge: Edge = {
        id: tempEdgeId,
        source: parentId,
        target: tempNodeId,
        type: 'custom', // 使用自定义边缘类型，确保与永久边缘使用相同的路径生成算法
        animated: false,
        style: {
          stroke: '#999', // 临时边使用灰色，以便区分
          strokeWidth: 2,
          strokeDasharray: '5,5', // 临时边使用虚线
        },
        data: {
          // 临时边缘连接到新建节点，所以 targetIsNewNode 为 true
          sourceIsNewNode: false,
          targetIsNewNode: true,
        },
      };
      setEdges((eds) => [...eds, tempEdge]);
    } else if (mode === 'sibling' && siblingId) {
      // 兄弟节点：找到兄弟节点的父节点，连接到同一个父节点
      const siblingNode = nodes.find(n => n.id === siblingId);
      if (siblingNode) {
        // 查找指向兄弟节点的边（即兄弟节点的父边）
        const parentEdge = edges.find(e => e.target === siblingId);
        if (parentEdge) {
          // 连接到同一个父节点
          tempEdgeId = `temp_edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          edgeSource = parentEdge.source;
          const tempEdge: Edge = {
            id: tempEdgeId,
            source: parentEdge.source,
            target: tempNodeId,
            type: 'custom', // 使用自定义边缘类型，确保与永久边缘使用相同的路径生成算法
            animated: false,
            style: {
              stroke: '#999', // 临时边使用灰色，以便区分
              strokeWidth: 2,
              strokeDasharray: '5,5', // 临时边使用虚线
            },
            data: {
              // 临时边缘连接到新建节点，所以 targetIsNewNode 为 true
              sourceIsNewNode: false,
              targetIsNewNode: true,
            },
          };
          console.log('创建兄弟节点临时边:', tempEdge, '兄弟节点ID:', siblingId, '父边:', parentEdge);
          setEdges((eds) => [...eds, tempEdge]);
        } else {
          // 如果没有找到父边，可能是根节点，不创建临时边
          // 但后端应该会处理这种情况
          console.warn('兄弟节点没有父边，可能是根节点，不创建临时边:', siblingId);
        }
      } else {
        console.error('找不到兄弟节点:', siblingId);
      }
    }
    
    // 将临时边ID存储到节点数据中，以便保存时使用
    if (tempEdgeId && edgeSource) {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === tempNodeId) {
            return {
              ...n,
              data: {
                ...n.data,
                tempEdgeId, // 临时边ID
                edgeSource, // 边的源节点
              },
            };
          }
          return n;
        })
      );
    }
    
    setSelectedNodeId(tempNodeId);
    
    // 新建节点后，如果自动布局开启，触发布局
    if (autoLayout) {
      setTimeout(() => {
        applyLayout();
      }, 100);
    }
  }, [nodes, edges, setNodes, setEdges, setSelectedNodeId, findNonOverlappingPosition, checkEdgeOverlap, autoLayout, applyLayout]);

  // 添加子节点
  const handleAddChild = useCallback(async (parentId: string) => {
    await handleAddNode(parentId, 'child');
  }, [handleAddNode]);

  // 添加兄弟节点
  const handleAddSibling = useCallback(async (siblingId: string) => {
    // 找到兄弟节点
    const siblingNode = nodes.find(n => n.id === siblingId);
    if (!siblingNode) {
      Notification.error('找不到兄弟节点');
      return;
    }
    
    // 获取兄弟节点的真实ID
    // 如果节点已经保存，使用保存后的ID；如果还是临时节点，使用临时ID
    const originalNode = siblingNode.data?.originalNode as MindMapNode;
    let realSiblingId = originalNode?.id || siblingId;
    
    // 如果兄弟节点是临时节点且还未保存，需要先保存它
    if (siblingNode.data.isNewNode) {
      Notification.error('兄弟节点还未保存，请先保存兄弟节点');
      return;
    }
    
    // 确保传递的是真实节点ID，而不是临时ID
    // 传递 undefined 作为 parentId，确保后端知道这是兄弟节点
    await handleAddNode(undefined, 'sibling', realSiblingId);
  }, [handleAddNode, nodes]);

  // 更新回调函数 ref
  useEffect(() => {
    callbacksRef.current = {
      onEdit: handleEditNode,
      onAddChild: handleAddChild,
      onAddSibling: handleAddSibling,
      onDelete: handleDeleteNode,
      onToggleExpand: handleToggleExpand,
    };
  }, [handleEditNode, handleAddChild, handleAddSibling, handleDeleteNode, handleToggleExpand]);

  // 将 MindMapNode 转换为 ReactFlow Node
  const initialFlowNodes = useMemo(() => {
    const flowEdges = mindMap.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })) as Edge[];
    
    const rootNodeIds = new Set(
      mindMap.nodes
        .filter(node => !mindMap.edges.some(edge => edge.target === node.id))
        .map(node => node.id)
    );
    
    return mindMap.nodes.map((node) => {
      const x = typeof node.x === 'number' && !isNaN(node.x) ? node.x : 0;
      const y = typeof node.y === 'number' && !isNaN(node.y) ? node.y : 0;
      const isRootNode = rootNodeIds.has(node.id);
      
      return {
        id: node.id,
        type: 'mindmap',
        position: { x, y },
        draggable: isRootNode,
        data: {
          originalNode: node,
          edges: flowEdges,
          isRootNode,
          docId: docId, // 传递 docId 用于获取卡片
          mmid: mindMap.mmid, // 传递 mmid 用于获取卡片
          branch: mindMap.currentBranch || 'main', // 传递 branch 用于跳转
          onDelete: (nodeId: string) => callbacksRef.current?.onDelete(nodeId),
          onEdit: (node: Node) => callbacksRef.current?.onEdit(node),
          onAddChild: (nodeId: string) => callbacksRef.current?.onAddChild(nodeId),
          onAddSibling: (nodeId: string) => callbacksRef.current?.onAddSibling(nodeId),
          onTextChange: (nodeId: string, newText: string) => {
            handleNodeTextChangeRef.current(nodeId, newText);
          },
          onEnterEdit: (nodeId: string) => {
            handleEnterEditRef.current(nodeId);
          },
          onExitEdit: (nodeId: string) => {
            handleExitEditRef.current(nodeId);
          },
        },
      } as Node;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mindMap.nodes, mindMap.edges]);

  // 计算每个节点的最大子分支数量（递归计算）
  const maxChildBranches = useMemo(() => {
    const maxBranches = new Map<string, number>();
    
    // 递归计算节点的最大子分支数
    const calculateMaxBranches = (nodeId: string): number => {
      if (maxBranches.has(nodeId)) {
        return maxBranches.get(nodeId)!;
      }
      
      const childEdges = mindMap.edges.filter(e => e.source === nodeId);
      if (childEdges.length === 0) {
        maxBranches.set(nodeId, 0);
        return 0;
      }
      
      // 计算直接子节点数
      const directChildren = childEdges.length;
      // 递归计算所有子节点的最大分支数
      const maxChildBranches = Math.max(...childEdges.map(e => calculateMaxBranches(e.target)));
      
      // 当前节点的最大分支数 = max(直接子节点数, 子节点的最大分支数)
      const maxBranchesForNode = Math.max(directChildren, maxChildBranches);
      maxBranches.set(nodeId, maxBranchesForNode);
      
      return maxBranchesForNode;
    };
    
    // 为所有节点计算最大分支数
    mindMap.nodes.forEach(node => {
      calculateMaxBranches(node.id);
    });
    
    return maxBranches;
  }, [mindMap.nodes, mindMap.edges]);

  // 根据最大分支数获取颜色
  const getColorByMaxBranches = (maxBranches: number): string => {
    // 定义颜色数组，根据最大分支数分配
    const colors = [
      '#2196f3', // 蓝色 - 0-2个分支
      '#4caf50', // 绿色 - 3-5个分支
      '#ff9800', // 橙色 - 6-8个分支
      '#f44336', // 红色 - 9-11个分支
      '#9c27b0', // 紫色 - 12-14个分支
      '#00bcd4', // 青色 - 15-17个分支
      '#ff5722', // 深橙色 - 18-20个分支
      '#607d8b', // 蓝灰色 - 21+个分支
    ];
    
    const index = Math.min(Math.floor(maxBranches / 3), colors.length - 1);
    return colors[index];
  };

  // 将 MindMapEdge 转换为 ReactFlow Edge
  const initialFlowEdges = useMemo(() => {
    return mindMap.edges.map((edge) => {
      const sourceMaxBranches = maxChildBranches.get(edge.source) || 0;
      const color = getColorByMaxBranches(sourceMaxBranches);
      
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: `source-${edge.target}`, // 使用目标节点ID作为sourceHandle，确保每个子节点使用不同的连接点
        type: 'custom', // 使用自定义边缘类型
        animated: false, // 移除动画
        // 移除箭头
        label: edge.label,
        style: {
          stroke: edge.color || color, // 使用动态分配的颜色
          strokeWidth: edge.width || 2,
        },
        data: {
          // 节点状态会在 useEffect 中更新
        },
      } as Edge;
    });
  }, [mindMap.edges, maxChildBranches]);

  // 初始化节点和边
  useEffect(() => {
    if (autoLayout && initialFlowNodes.length > 0 && initialFlowEdges.length > 0) {
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(initialFlowNodes, initialFlowEdges);
      
      // 更新 originalNode 的位置
      const nodesWithUpdatedOriginal = layoutedNodes.map((n) => {
        const originalNode = n.data.originalNode as MindMapNode;
        if (originalNode) {
          return {
            ...n,
            data: {
              ...n.data,
              originalNode: {
                ...originalNode,
                x: n.position.x,
                y: n.position.y,
              },
            },
          };
        }
        return n;
      });
      
      setNodes(nodesWithUpdatedOriginal);
      setEdges(layoutedEdges);
      nodesRef.current = nodesWithUpdatedOriginal;
      edgesRef.current = layoutedEdges;
    } else {
      setNodes(initialFlowNodes);
      setEdges(initialFlowEdges);
      nodesRef.current = initialFlowNodes;
      edgesRef.current = initialFlowEdges;
    }
  }, [initialFlowNodes, initialFlowEdges, setNodes, setEdges, autoLayout]);
  
  // 当自动布局开关变化时，重新应用布局
  useEffect(() => {
    if (autoLayout && nodes.length > 0 && edges.length > 0 && !isDraggingRef.current) {
      applyLayout();
    }
  }, [autoLayout, applyLayout]);

  // 使用 ref 存储 handleNodeTextChange，避免在 useEffect 依赖中引起循环
  const handleNodeTextChangeRef = useRef(handleNodeTextChange);
  useEffect(() => {
    handleNodeTextChangeRef.current = handleNodeTextChange;
  }, [handleNodeTextChange]);

  // 使用 ref 存储 handleEnterEdit，避免在 useEffect 依赖中引起循环
  const handleEnterEditRef = useRef(handleEnterEdit);
  useEffect(() => {
    handleEnterEditRef.current = handleEnterEdit;
  }, [handleEnterEdit]);

  // 使用 ref 存储 handleExitEdit，避免在 useEffect 依赖中引起循环
  const handleExitEditRef = useRef(handleExitEdit);
  useEffect(() => {
    handleExitEditRef.current = handleExitEdit;
  }, [handleExitEdit]);

  // 使用 ref 存储 edges，避免在 useEffect 依赖中引起循环
  const edgesRefForNodes = useRef(edges);
  useEffect(() => {
    edgesRefForNodes.current = edges;
  }, [edges]);

  // 当节点状态变化时，更新边缘的 data，以便边缘组件能够根据节点是否为新建节点显示虚线或实线
  // 更新所有 'custom' 类型的边缘（包括临时边缘和永久边缘）
  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        // 只更新 'custom' 类型的边缘
        if (edge.type === 'custom') {
          // 查找源节点和目标节点，获取它们的 isNewNode 状态
          const sourceNode = nodes.find(n => n.id === edge.source);
          const targetNode = nodes.find(n => n.id === edge.target);
          const sourceIsNewNode = sourceNode?.data?.isNewNode || false;
          const targetIsNewNode = targetNode?.data?.isNewNode || false;
          
          return {
            ...edge,
            data: {
              ...edge.data,
              sourceIsNewNode,
              targetIsNewNode,
            },
          };
        }
        // 其他类型的边缘保持原样（虽然现在应该都是 'custom' 类型了）
        return edge;
      })
    );
  }, [nodes, setEdges]);


  useEffect(() => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    
    const flowEdges = currentEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })) as Edge[];
    
    const rootNodeIds = new Set(
      currentNodes
        .filter(node => !currentEdges.some(edge => edge.target === node.id))
        .map(node => node.id)
    );

    setNodes((nds) =>
      nds.map((n) => {
        const isRootNode = rootNodeIds.has(n.id);
        return {
          ...n,
          selected: n.id === selectedNodeId,
          draggable: isRootNode,
          data: {
            ...n.data,
            selected: n.id === selectedNodeId,
            isRootNode,
            edges: edgesRefForNodes.current,
            docId: n.data.docId || docId, // 保留或设置 docId
            mmid: n.data.mmid || mindMap.mmid, // 保留或设置 mmid
            branch: n.data.branch || mindMap.currentBranch || 'main', // 保留或设置 branch
            onTextChange: (nodeId: string, newText: string) => {
              handleNodeTextChangeRef.current(nodeId, newText);
            },
            onEnterEdit: (nodeId: string) => {
              handleEnterEditRef.current(nodeId);
            },
            onExitEdit: (nodeId: string) => {
              handleExitEditRef.current(nodeId);
            },
            onToggleExpand: (nodeId: string) => callbacksRef.current?.onToggleExpand(nodeId),
          },
        };
      })
    );
  }, [selectedNodeId, setNodes]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);


  // 节点点击事件 - 仅选中节点，不弹出对话框
  const onNodeClick: NodeMouseHandler = useCallback((event, node) => {
    event.preventDefault();
    event.stopPropagation();
    // 只有在没有拖拽的情况下才选中节点
    // 注意：如果刚刚拖拽结束，isDraggingRef 可能已经被重置，所以需要延迟检查
    setTimeout(() => {
      if (!isDraggingRef.current) {
        setSelectedNodeId(node.id);
        console.log('Node clicked:', node.id, 'Selected node ID:', node.id);
      }
    }, 50);
  }, []);

  // 节点双击事件 - 进入编辑模式
  const onNodeDoubleClick: NodeMouseHandler = useCallback((event, node) => {
    event.preventDefault();
    event.stopPropagation();
    // 如果节点不是新节点且不在编辑模式，则进入编辑模式
    const isNewNode = node.data.isNewNode || false;
    const isEditing = node.data.isEditing || false;
    if (!isNewNode && !isEditing) {
      // 使用回调函数进入编辑模式
      if (node.data.onEnterEdit) {
        node.data.onEnterEdit(node.id);
      } else {
        // 降级方案：直接设置状态
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === node.id) {
              return {
                ...n,
                data: {
                  ...n.data,
                  isEditing: true,
                },
              };
            }
            return n;
          })
        );
      }
    }
  }, [setNodes]);


  // 点击画布空白处取消选中
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // 连接节点
  const onConnect = useCallback(
    async (params: Connection) => {
      if (!params.source || !params.target) return;

      try {
        const response = await request.post(getMindMapUrl('/edge', docId), {
          operation: 'add',
          source: params.source,
          target: params.target,
        });

        const newEdge: Edge = {
          ...params,
          id: response.edgeId,
          type: 'custom', // 使用自定义边缘类型
          animated: false,
          data: {
            // 节点状态会在 useEffect 中自动更新
          },
        };

        setEdges((eds) => addEdge(newEdge, eds));
        Notification.success('连接已添加');
        // 触发自动保存
        triggerAutoSave();
      } catch (error: any) {
        Notification.error('添加连接失败: ' + (error.message || '未知错误'));
      }
    },
    [docId, setEdges, triggerAutoSave]
  );

  const rootNodeDragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const rootNodeIdRef = useRef<string | null>(null);
  const allNodesStartPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const onNodeDragStart = useCallback((event: any, node: Node) => {
    const isRootNode = node.data?.isRootNode;
    if (!isRootNode) {
      return;
    }
    isDraggingRef.current = true;
    autoLayoutEnabledRef.current = false;
    rootNodeIdRef.current = node.id;
    rootNodeDragStartPosRef.current = { x: node.position.x, y: node.position.y };
    
    // 记录所有节点在拖动开始时的位置，保持相对位置关系
    allNodesStartPositionsRef.current.clear();
    nodes.forEach((n) => {
      allNodesStartPositionsRef.current.set(n.id, {
        x: n.position.x,
        y: n.position.y,
      });
    });
  }, [nodes]);

  const onNodeDrag = useCallback((event: any, node: Node) => {
    const isRootNode = node.data?.isRootNode;
    if (!isRootNode || !rootNodeDragStartPosRef.current || !rootNodeIdRef.current) {
      return;
    }

    // 清除自动布局的定时器，避免在拖动时触发
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = null;
    }

    // 计算根节点的位移
    const deltaX = node.position.x - rootNodeDragStartPosRef.current.x;
    const deltaY = node.position.y - rootNodeDragStartPosRef.current.y;

    // 所有节点都基于拖动开始时的位置加上相同的位移，保持相对位置关系不变
    setNodes((nds) =>
      nds.map((n) => {
        const startPos = allNodesStartPositionsRef.current.get(n.id);
        if (!startPos) {
          return n;
        }
        return {
          ...n,
          position: {
            x: startPos.x + deltaX,
            y: startPos.y + deltaY,
          },
        };
      })
    );
  }, [setNodes]);

  const onNodeDragStop = useCallback((event: any, node: Node) => {
    const isRootNode = node.data?.isRootNode;
    if (!isRootNode || !isDraggingRef.current) {
      isDraggingRef.current = false;
      rootNodeDragStartPosRef.current = null;
      rootNodeIdRef.current = null;
      return;
    }

    // 更新所有节点的 originalNode 位置，以便下次拖动时使用新位置
    setNodes((nds) =>
      nds.map((n) => {
        const originalNode = n.data.originalNode as MindMapNode;
        if (originalNode) {
          return {
            ...n,
            data: {
              ...n.data,
              originalNode: {
                ...originalNode,
                x: n.position.x,
                y: n.position.y,
              },
            },
          };
        }
        return n;
      })
    );

    // 延迟重置拖动状态，确保自动布局不会立即触发
    requestAnimationFrame(() => {
      setTimeout(() => {
        triggerAutoSave();
        // 再延迟一点重置，确保自动布局不会在拖动刚结束时触发
        setTimeout(() => {
          isDraggingRef.current = false;
          autoLayoutEnabledRef.current = true;
          rootNodeDragStartPosRef.current = null;
          rootNodeIdRef.current = null;
        }, 500);
      }, 100);
    });
  }, [triggerAutoSave]);

  // 键盘快捷键支持
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 如果正在输入，不处理快捷键
      if ((event.target as HTMLElement)?.tagName === 'INPUT' || 
          (event.target as HTMLElement)?.tagName === 'TEXTAREA') {
        return;
      }

      if (selectedNodeId) {
        const selectedNode = nodes.find(n => n.id === selectedNodeId);
        if (selectedNode) {
          if (event.key === 'Tab') {
            event.preventDefault();
            handleAddNode(selectedNodeId);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            // 找到父节点
            const parentEdge = edges.find(e => e.target === selectedNodeId);
            const parentId = parentEdge?.source;
            handleAddNode(parentId);
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            handleDeleteNode(selectedNodeId);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, nodes, edges, handleAddNode, handleDeleteNode]);

  // 递归获取所有子节点ID（包括子节点的子节点）
  const getAllDescendantIds = useCallback((nodeId: string, allNodes: Node[], allEdges: Edge[]): Set<string> => {
    const descendantIds = new Set<string>();
    const queue = [nodeId];
    
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const childEdges = allEdges.filter(e => e.source === currentId);
      for (const edge of childEdges) {
        if (!descendantIds.has(edge.target)) {
          descendantIds.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    
    return descendantIds;
  }, []);

  // 根据 expanded 状态过滤节点和边
  const filteredNodesAndEdges = useMemo(() => {
    const visibleNodeIds = new Set<string>();
    const visibleEdgeIds = new Set<string>();
    
    // 从根节点开始，递归遍历
    const traverse = (nodeId: string) => {
      visibleNodeIds.add(nodeId);
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      
      const originalNode = node.data.originalNode as MindMapNode;
      const expanded = originalNode?.expanded !== false; // 默认为 true
      
      if (expanded) {
        // 如果节点展开，添加所有子节点
        const childEdges = edges.filter(e => e.source === nodeId);
        for (const edge of childEdges) {
          visibleEdgeIds.add(edge.id);
          traverse(edge.target);
        }
      }
    };
    
    // 找到所有根节点（没有父边的节点）
    const rootNodes = nodes.filter(node => 
      !edges.some(edge => edge.target === node.id)
    );
    
    // 从每个根节点开始遍历
    for (const rootNode of rootNodes) {
      traverse(rootNode.id);
    }
    
    return {
      filteredNodes: nodes.filter(n => visibleNodeIds.has(n.id)),
      filteredEdges: edges.filter(e => visibleEdgeIds.has(e.id)),
    };
  }, [nodes, edges]);

  // 按层组织节点（广度优先，跳过根节点，从根节点的子节点开始作为第0层）
  const nodesByLayer = useMemo(() => {
    const layers: { layer: number; nodes: Node[] }[] = [];
    const visited = new Set<string>();
    const nodeMap = new Map<string, Node>();
    
    nodes.forEach(node => {
      nodeMap.set(node.id, node);
    });

    // 找到根节点（没有父边的节点）
    const rootNodes = nodes.filter(node => 
      !edges.some(edge => edge.target === node.id)
    );

    if (rootNodes.length === 0) return layers;

    // 从根节点的子节点开始，作为第0层
    const queue: { nodeId: string; layer: number }[] = [];
    rootNodes.forEach(root => {
      // 不添加根节点，直接添加根节点的子节点
      const childEdges = edges.filter(e => e.source === root.id);
      for (const edge of childEdges) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ nodeId: edge.target, layer: 0 });
        }
      }
    });

    while (queue.length > 0) {
      const { nodeId, layer } = queue.shift()!;
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      // 确保层数组有足够的空间
      while (layers.length <= layer) {
        layers.push({ layer: layers.length, nodes: [] });
      }
      layers[layer].nodes.push(node);

      // 添加子节点到队列
      const childEdges = edges.filter(e => e.source === nodeId);
      for (const edge of childEdges) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ nodeId: edge.target, layer: layer + 1 });
        }
      }
    }

    return layers;
  }, [nodes, edges]);

  // 获取当前层的卡片列表
  const currentLayerCards = useMemo(() => {
    if (studyLayer >= nodesByLayer.length) return [];
    const layerNodes = nodesByLayer[studyLayer].nodes;
    return layerNodes.map(node => {
      const originalNode = node.data.originalNode as MindMapNode;
      const childEdges = edges.filter(e => e.source === node.id);
      const children = childEdges.map(e => {
        const childNode = nodes.find(n => n.id === e.target);
        return childNode ? (childNode.data.originalNode as MindMapNode) : null;
      }).filter(Boolean) as MindMapNode[];

      return {
        parent: originalNode,
        children,
      };
    });
  }, [studyLayer, nodesByLayer, nodes, edges]);

  // 翻转卡片
  const handleFlipCard = useCallback(() => {
    setIsCardFlipped(!isCardFlipped);
  }, [isCardFlipped]);

  // 下一个卡片
  const handleNextCard = useCallback(() => {
    if (studyCardIndex < currentLayerCards.length - 1) {
      setStudyCardIndex(studyCardIndex + 1);
      setIsCardFlipped(false);
    }
  }, [studyCardIndex, currentLayerCards.length]);

  // 上一个卡片
  const handlePrevCard = useCallback(() => {
    if (studyCardIndex > 0) {
      setStudyCardIndex(studyCardIndex - 1);
      setIsCardFlipped(false);
    }
  }, [studyCardIndex]);

  // 切换层时重置卡片索引
  useEffect(() => {
    setStudyCardIndex(0);
    setIsCardFlipped(false);
  }, [studyLayer]);

  // 沉浸模式视图
  if (isImmersive) {
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        background: '#f5f5f5',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* 沉浸模式工具栏 */}
        <div style={{
          padding: '10px 20px',
          background: '#fff',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          zIndex: 10000, // 确保工具栏在最上层
          position: 'relative',
        }}>
          <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#333' }}>
            {mindMap.title} - 沉浸模式
          </div>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsImmersive(false);
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            style={{
              padding: '8px 16px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#f44336',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              zIndex: 10001, // 确保按钮在最上层
              position: 'relative',
            }}
            title="退出沉浸模式（或按 ESC 键）"
          >
            <span>✕</span>
            <span>退出沉浸模式</span>
          </button>
        </div>
        
        {/* 沉浸模式思维导图 */}
        <div style={{ flex: 1, width: '100%', position: 'relative' }}>
          <ReactFlow
            nodes={filteredNodesAndEdges.filteredNodes}
            edges={filteredNodesAndEdges.filteredEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onInit={setReactFlowInstance}
            nodeTypes={customNodeTypes}
            edgeTypes={customEdgeTypes}
            fitView
            nodesConnectable={true}
            edgesUpdatable={true}
            edgesFocusable={true}
            deleteKeyCode="Delete"
            multiSelectionKeyCode="Shift"
            connectionLineStyle={{ stroke: '#2196f3', strokeWidth: 2 }}
            defaultViewport={mindMap.viewport ? {
              x: mindMap.viewport.x,
              y: mindMap.viewport.y,
              zoom: (mindMap.viewport.zoom || 1) * 1.5, // 沉浸模式下放大1.5倍
            } : { x: 0, y: 0, zoom: 1.5 }}
            style={{
              background: '#f5f5f5',
            }}
          >
            <Controls />
          </ReactFlow>
          
          {/* 悬浮工具栏 */}
          {selectedNodeId && reactFlowInstance && (() => {
            const selectedNode = nodes.find(n => n.id === selectedNodeId);
            if (!selectedNode) return null;
            return (
              <FloatingToolbar
                node={selectedNode}
                reactFlowInstance={reactFlowInstance}
                onDelete={handleDeleteNode}
                onUpdateFontSize={handleUpdateFontSize}
                onUpdateColor={handleUpdateColor}
                onCopy={handleCopyNodeContent}
                onManageCards={handleManageCards}
                onEdit={handleEditNode}
              />
            );
          })()}
          
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
      {/* 工具栏 */}
      <div style={{
        padding: '10px 20px',
        background: '#f5f5f5',
        borderBottom: '1px solid #ddd',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        {/* 模式切换按钮 */}
        <button
          onClick={() => setViewMode('mindmap')}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: viewMode === 'mindmap' ? '#2196f3' : '#fff',
            color: viewMode === 'mindmap' ? '#fff' : '#333',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          导图模式
        </button>
        <button
          onClick={() => setViewMode('outline')}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: viewMode === 'outline' ? '#4caf50' : '#fff',
            color: viewMode === 'outline' ? '#fff' : '#333',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          文件模式
        </button>
        <button
          onClick={() => setViewMode('study')}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: viewMode === 'study' ? '#ff9800' : '#fff',
            color: viewMode === 'study' ? '#fff' : '#333',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          刷题模式
        </button>
        <button
          onClick={() => setViewMode('yaml')}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: viewMode === 'yaml' ? '#9c27b0' : '#fff',
            color: viewMode === 'yaml' ? '#fff' : '#333',
            cursor: 'pointer',
            fontWeight: 'bold',
          }}
        >
          YAML模式
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setIsImmersive(true)}
            style={{
              padding: '6px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#fff',
              color: '#333',
              cursor: 'pointer',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            title="进入沉浸模式（全屏）"
          >
            <span>🔍</span>
            <span>沉浸模式</span>
          </button>
        </div>
      </div>

      {/* 思维导图画布或大纲视图 */}
      <div ref={reactFlowWrapper} style={{ flex: 1, width: '100%', position: 'relative' }}>
        {viewMode === 'mindmap' ? (
          <>
            <ReactFlow
              nodes={filteredNodesAndEdges.filteredNodes}
              edges={filteredNodesAndEdges.filteredEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onPaneClick={onPaneClick}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onInit={setReactFlowInstance}
              nodeTypes={customNodeTypes}
              edgeTypes={customEdgeTypes}
              fitView
              nodesConnectable={true}
              edgesUpdatable={true}
              edgesFocusable={true}
              deleteKeyCode="Delete"
              multiSelectionKeyCode="Shift"
              connectionLineStyle={{ stroke: '#2196f3', strokeWidth: 2 }}
              defaultViewport={mindMap.viewport ? {
                x: mindMap.viewport.x,
                y: mindMap.viewport.y,
                zoom: mindMap.viewport.zoom,
              } : undefined}
              style={{
                background: '#f5f5f5',
              }}
            >
              <Controls />
            </ReactFlow>
            
            {/* 悬浮工具栏 */}
            {selectedNodeId && reactFlowInstance && (() => {
              const selectedNode = nodes.find(n => n.id === selectedNodeId);
              if (!selectedNode) return null;
              return (
                <FloatingToolbar
                  node={selectedNode}
                  reactFlowInstance={reactFlowInstance}
                  onDelete={handleDeleteNode}
                  onUpdateFontSize={handleUpdateFontSize}
                  onUpdateColor={handleUpdateColor}
                  onCopy={handleCopyNodeContent}
                  onManageCards={handleManageCards}
                  onEdit={handleEditNode}
                />
              );
            })()}
            
          </>
        ) : viewMode === 'outline' ? (
          <OutlineView
            nodes={nodes}
            edges={edges}
            onToggleExpand={handleToggleExpand}
            onNodeClick={setSelectedNodeId}
            selectedNodeId={selectedNodeId}
          />
        ) : viewMode === 'yaml' ? (
          <YamlView
            nodes={nodes}
            edges={edges}
            onSave={handleSaveFromYaml}
            docId={docId}
            isSaving={isSaving}
          />
        ) : (
          <StudyView
            nodesByLayer={nodesByLayer}
            currentLayer={studyLayer}
            onLayerChange={setStudyLayer}
            currentCardIndex={studyCardIndex}
            currentLayerCards={currentLayerCards}
            isCardFlipped={isCardFlipped}
            onFlipCard={handleFlipCard}
            onNextCard={handleNextCard}
            onPrevCard={handlePrevCard}
          />
        )}
      </div>
    </div>
  );
}

// 刷题模式视图组件
const StudyView = ({
  nodesByLayer,
  currentLayer,
  onLayerChange,
  currentCardIndex,
  currentLayerCards,
  isCardFlipped,
  onFlipCard,
  onNextCard,
  onPrevCard,
}: {
  nodesByLayer: { layer: number; nodes: Node[] }[];
  currentLayer: number;
  onLayerChange: (layer: number) => void;
  currentCardIndex: number;
  currentLayerCards: { parent: MindMapNode; children: MindMapNode[] }[];
  isCardFlipped: boolean;
  onFlipCard: () => void;
  onNextCard: () => void;
  onPrevCard: () => void;
}) => {
  const currentCard = currentLayerCards[currentCardIndex];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px',
        backgroundColor: '#f5f5f5',
      }}
    >
      {/* 层选择器 */}
      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '14px', fontWeight: '600', color: '#333' }}>选择层：</span>
        {nodesByLayer.map((layer, index) => (
          <button
            key={index}
            onClick={() => onLayerChange(index)}
            style={{
              padding: '6px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: currentLayer === index ? '#2196f3' : '#fff',
              color: currentLayer === index ? '#fff' : '#333',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            第 {index + 1} 层 ({layer.nodes.length} 个节点)
          </button>
        ))}
      </div>

      {/* 卡片容器 */}
      {currentCard ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {/* 卡片进度 */}
          <div style={{ marginBottom: '20px', fontSize: '14px', color: '#666' }}>
            {currentCardIndex + 1} / {currentLayerCards.length}
          </div>

          {/* 卡片 */}
          <div
            onClick={(e) => {
              if ((e.target as HTMLElement).tagName !== 'BUTTON') {
                onFlipCard();
              }
            }}
            style={{
              width: '100%',
              maxWidth: '800px',
              minHeight: '400px',
              perspective: '1000px',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                transformStyle: 'preserve-3d',
                transition: 'transform 0.6s',
                transform: isCardFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
              }}
            >
              {/* 卡片正面 */}
              <div
                style={{
                  position: 'absolute',
                  width: '100%',
                  height: '100%',
                  backfaceVisibility: 'hidden',
                  WebkitBackfaceVisibility: 'hidden',
                  border: '2px solid #2196F3',
                  borderRadius: '12px',
                  padding: '30px',
                  background: '#fff',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  display: isCardFlipped ? 'none' : 'block',
                }}
              >
                <div style={{ fontSize: '20px', fontWeight: '600', color: '#333', marginBottom: '20px' }}>
                  父节点
                </div>
                <div
                  style={{
                    fontSize: '24px',
                    fontWeight: '600',
                    color: currentCard.parent.color || '#333',
                    marginBottom: '30px',
                    padding: '15px',
                    backgroundColor: '#f5f5f5',
                    borderRadius: '8px',
                  }}
                >
                  {currentCard.parent.text || '未命名节点'}
                </div>
                <div style={{ fontSize: '20px', fontWeight: '600', color: '#333', marginBottom: '20px' }}>
                  子节点分支（{currentCard.children.length} 个）
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  {currentCard.children.map((child, index) => (
                    <div
                      key={index}
                      style={{
                        padding: '10px 15px',
                        backgroundColor: '#e3f2fd',
                        borderRadius: '6px',
                        fontSize: '16px',
                        color: '#666',
                        border: '1px dashed #90caf9',
                      }}
                    >
                      {child.text || '未命名节点'}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '30px', fontSize: '14px', color: '#999', textAlign: 'center' }}>
                  点击卡片查看答案
                </div>
              </div>

              {/* 卡片反面 */}
              <div
                style={{
                  position: 'absolute',
                  width: '100%',
                  height: '100%',
                  backfaceVisibility: 'hidden',
                  WebkitBackfaceVisibility: 'hidden',
                  transform: 'rotateY(180deg)',
                  border: '2px solid #2196F3',
                  borderRadius: '12px',
                  padding: '30px',
                  background: '#fff',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  display: isCardFlipped ? 'block' : 'none',
                }}
              >
                <div style={{ fontSize: '20px', fontWeight: '600', color: '#333', marginBottom: '20px' }}>
                  完整内容
                </div>
                <div
                  style={{
                    fontSize: '24px',
                    fontWeight: '600',
                    color: currentCard.parent.color || '#333',
                    marginBottom: '30px',
                    padding: '15px',
                    backgroundColor: '#f5f5f5',
                    borderRadius: '8px',
                  }}
                >
                  {currentCard.parent.text || '未命名节点'}
                </div>
                <div style={{ fontSize: '20px', fontWeight: '600', color: '#333', marginBottom: '20px' }}>
                  子节点
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  {currentCard.children.map((child, index) => (
                    <div
                      key={index}
                      style={{
                        padding: '15px',
                        backgroundColor: '#e3f2fd',
                        borderRadius: '8px',
                        fontSize: '18px',
                        color: child.color || '#333',
                        border: '1px solid #90caf9',
                      }}
                    >
                      {child.text || '未命名节点'}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '30px', fontSize: '14px', color: '#999', textAlign: 'center' }}>
                  点击卡片返回题目
                </div>
              </div>
            </div>
          </div>

          {/* 控制按钮 */}
          <div style={{ marginTop: '30px', display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button
              onClick={onPrevCard}
              disabled={currentCardIndex === 0}
              style={{
                padding: '12px 24px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                background: currentCardIndex === 0 ? '#f5f5f5' : '#fff',
                color: currentCardIndex === 0 ? '#999' : '#333',
                cursor: currentCardIndex === 0 ? 'not-allowed' : 'pointer',
                fontSize: '16px',
              }}
            >
              上一个
            </button>
            <button
              onClick={onNextCard}
              disabled={currentCardIndex >= currentLayerCards.length - 1}
              style={{
                padding: '12px 24px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                background: currentCardIndex >= currentLayerCards.length - 1 ? '#f5f5f5' : '#4caf50',
                color: currentCardIndex >= currentLayerCards.length - 1 ? '#999' : '#fff',
                cursor: currentCardIndex >= currentLayerCards.length - 1 ? 'not-allowed' : 'pointer',
                fontSize: '16px',
              }}
            >
              下一个
            </button>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', color: '#999' }}>
          该层没有节点
        </div>
      )}
    </div>
  );
};

// 节点到 YAML 的转换函数
const convertNodesToYaml = (nodes: Node[], edges: Edge[]): string => {
  // 构建节点树结构
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

  // 递归转换节点为 YAML 字符串（通过缩进表示层级，支持卡片）
  const convertNodeToYamlString = (nodeId: string, indent: number = 0): string => {
    const nodeData = nodeMap.get(nodeId);
    if (!nodeData) return '';

    const { node, children } = nodeData;
    const originalNode = node.data.originalNode as MindMapNode;
    const nodeText = originalNode?.text || '';
    const indentStr = '  '.repeat(indent);

    // 获取节点的卡片信息
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[nodeId] || [];

    const hasNestedContent = nodeCards.length > 0 || children.length > 0;
    const safeNodeText = yaml.dump(nodeText || '', { lineWidth: -1 }).trim();
    let result = hasNestedContent ? `${indentStr}- ${safeNodeText}:` : `${indentStr}- ${safeNodeText}`;

    const childIndentStr = '  '.repeat(indent + 1);

    if (nodeCards.length > 0) {
      result += '\n' + `${childIndentStr}- cards:`;
      const cardEntryIndent = '  '.repeat(indent + 2);
      nodeCards.forEach((card: Card) => {
        const titleValue = yaml.dump(card.title || '', { lineWidth: -1 }).trim();
        const cardContent = card.content || '';
        result += '\n' + `${cardEntryIndent}- title: ${titleValue}`;
        if (cardContent.trim()) {
          const contentLines = cardContent.split('\n');
          if (contentLines.length > 1) {
            result += '\n' + `${cardEntryIndent}  content: |`;
            const contentIndent = '  '.repeat(indent + 3);
            contentLines.forEach((line: string) => {
              result += '\n' + `${contentIndent}${line}`;
            });
          } else {
            const contentValue = yaml.dump(cardContent, { lineWidth: -1 }).trim();
            result += '\n' + `${cardEntryIndent}  content: ${contentValue}`;
          }
        }
      });
    }

    if (children.length > 0) {
      children.forEach((childId) => {
        result += '\n' + convertNodeToYamlString(childId, indent + 1);
      });
    }

    return result;
  };

  // 转换所有根节点为 YAML 字符串
  if (rootNodes.length === 0) {
    return '';
  }

  const yamlLines: string[] = [];
  rootNodes.forEach((rootId) => {
    const rootYaml = convertNodeToYamlString(rootId, 0);
    if (rootYaml) {
      yamlLines.push(rootYaml);
    }
  });

  return yamlLines.join('\n');
};

// YAML 到节点的解析函数（合法 YAML 结构，支持 cards）
const parseYamlToNodes = (yamlText: string, existingNodes: Node[], existingEdges: Edge[]): { nodes: MindMapNode[]; edges: MindMapEdge[]; cards: Array<{ nodeId: string; cards: Card[] }> } => {
  try {
    const yamlData = yaml.load(yamlText) as any;
    if (!yamlData || !Array.isArray(yamlData)) {
      Notification.error('YAML 格式需要是以列表开头的结构');
      return { nodes: [], edges: [], cards: [] };
    }

    const newNodes: MindMapNode[] = [];
    const newEdges: MindMapEdge[] = [];
    const cardsMap = new Map<string, Card[]>();
    let nodeIdCounter = 0;

    const normalizeString = (value: any): string => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      return String(value);
    };

    const getExistingNode = (text: string, parentId: string | null) => {
      if (parentId) {
        return existingNodes.find(n => {
          const orig = n.data.originalNode as MindMapNode;
          return orig.text === text && orig.parentId === parentId;
        })?.data.originalNode as MindMapNode | undefined;
      }
      return existingNodes.find(n => {
        const orig = n.data.originalNode as MindMapNode;
        return orig.text === text && !orig.parentId;
      })?.data.originalNode as MindMapNode | undefined;
    };

    const createNode = (text: string, parentId: string | null): string => {
      const existingNode = getExistingNode(text, parentId);
      const finalNodeId = existingNode?.id || `node_${nodeIdCounter++}`;

      const newNode: MindMapNode = {
        id: finalNodeId,
        text,
        parentId: parentId || undefined,
        expanded: true,
        ...(existingNode ? {
          x: existingNode.x,
          y: existingNode.y,
          color: existingNode.color,
          backgroundColor: existingNode.backgroundColor,
          fontSize: existingNode.fontSize,
          shape: existingNode.shape,
          expanded: existingNode.expanded,
        } : {}),
      };

      newNodes.push(newNode);

      if (parentId) {
        const existingEdge = existingEdges.find(e => e.source === parentId && e.target === finalNodeId);
        if (existingEdge) {
          newEdges.push({
            id: existingEdge.id,
            source: parentId,
            target: finalNodeId,
            label: typeof existingEdge.label === 'string' ? existingEdge.label : undefined,
            color: (existingEdge.style as any)?.stroke,
            width: (existingEdge.style as any)?.strokeWidth,
          });
        } else {
          newEdges.push({
            id: `edge_${parentId}_${finalNodeId}`,
            source: parentId,
            target: finalNodeId,
          });
        }
      }

      return finalNodeId;
    };

    const addCardsForNode = (nodeId: string, rawCards: any) => {
      if (!Array.isArray(rawCards)) return;
      const normalized = rawCards.map((card: any, index: number): Card | null => {
        if (typeof card === 'string') {
          return {
            docId: '',
            cid: index + 1,
            title: card,
            content: '',
            updateAt: new Date().toISOString(),
          };
        }
        if (card && typeof card === 'object') {
          const cidValue = typeof card.cid === 'number'
            ? card.cid
            : (typeof card.cid === 'string' ? Number(card.cid) : NaN);
          const normalizedCid = Number.isFinite(cidValue) && cidValue > 0 ? cidValue : (index + 1);
          return {
            docId: card.docId || card.id || '',
            cid: normalizedCid,
            title: normalizeString(card.title || ''),
            content: normalizeString(card.content || ''),
            updateAt: card.updateAt || new Date().toISOString(),
            createdAt: card.createdAt,
          };
        }
        return null;
      }).filter((card): card is Card => card !== null);

      if (normalized.length > 0) {
        cardsMap.set(nodeId, normalized);
      }
    };

    const isCardsEntry = (entry: any): entry is { cards: any } => {
      return !!entry && typeof entry === 'object' && 'cards' in entry && Object.keys(entry).length === 1;
    };

    const processEntries = (entries: any[], parentId: string | null) => {
      entries.forEach(entry => {
        processEntry(entry, parentId);
      });
    };

    const processEntry = (entry: any, parentId: string | null) => {
      if (entry === null || entry === undefined) {
        return;
      }

      if (typeof entry === 'string') {
        createNode(entry, parentId);
        return;
      }

      if (typeof entry === 'object') {
        // 卡片块
        if (isCardsEntry(entry) && parentId) {
          addCardsForNode(parentId, entry.cards);
          return;
        }

        const keys = Object.keys(entry);
        if (keys.length === 0) return;

        const nodeName = keys[0];
        const nodeValue = entry[nodeName];
        const nodeId = createNode(nodeName, parentId);

        if (Array.isArray(nodeValue)) {
          processEntries(nodeValue, nodeId);
        } else if (nodeValue && typeof nodeValue === 'object') {
          if (Array.isArray(nodeValue.cards)) {
            addCardsForNode(nodeId, nodeValue.cards);
          }
          if (Array.isArray((nodeValue as any).children)) {
            processEntries((nodeValue as any).children, nodeId);
          }
        }
        return;
      }

      // 其他类型（数字、布尔等）转换为字符串节点
      createNode(String(entry), parentId);
    };

    processEntries(yamlData, null);

    const cardsData = Array.from(cardsMap.entries()).map(([nodeId, cards]) => ({
      nodeId,
      cards,
    }));

    return { nodes: newNodes, edges: newEdges, cards: cardsData };
  } catch (error: any) {
    try {
      return parseYamlLinesToNodes(yamlText, existingNodes, existingEdges);
    } catch (e: any) {
      Notification.error('YAML 解析失败: ' + (error.message || '未知错误'));
      return { nodes: [], edges: [], cards: [] };
    }
  }
};

// 行解析（兼容旧格式，主要用于回退，卡片不会被解析）
const parseYamlLinesToNodes = (yamlText: string, existingNodes: Node[], existingEdges: Edge[]): { nodes: MindMapNode[]; edges: MindMapEdge[]; cards: Array<{ nodeId: string; cards: Card[] }> } => {
  const lines = yamlText.split('\n').filter(line => line.trim());
  if (lines.length === 0) {
    Notification.error('YAML 内容为空');
    return { nodes: [], edges: [], cards: [] };
  }

  // 解析每一行，提取缩进层级和文本
  interface LineInfo {
    indent: number;
    text: string;
  }

  const lineInfos: LineInfo[] = lines.map((line) => {
    const nodeMatch = line.match(/^(\s*)- (.+)$/);
    if (nodeMatch) {
      const indent = nodeMatch[1].length;
      const text = nodeMatch[2].trim();
      return { indent, text };
    }
    return null;
  }).filter((info): info is LineInfo => info !== null);

  if (lineInfos.length === 0) {
    Notification.error('YAML 格式错误：未找到有效的节点');
    return { nodes: [], edges: [], cards: [] };
  }

  const newNodes: MindMapNode[] = [];
  const newEdges: MindMapEdge[] = [];
  let nodeIdCounter = 0;

  interface NodeStackItem {
    nodeId: string;
    indent: number;
  }
  const stack: NodeStackItem[] = [];

  lineInfos.forEach((lineInfo) => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= lineInfo.indent) {
      stack.pop();
    }

    const parentId = stack.length > 0 ? stack[stack.length - 1].nodeId : null;
    const nodeId = `node_${nodeIdCounter++}`;

    let existingNode: MindMapNode | undefined;
    if (parentId) {
      existingNode = existingNodes.find(n => {
        const orig = n.data.originalNode as MindMapNode;
        return orig.text === lineInfo.text && orig.parentId === parentId;
      })?.data.originalNode as MindMapNode;
    } else {
      existingNode = existingNodes.find(n => {
        const orig = n.data.originalNode as MindMapNode;
        return orig.text === lineInfo.text && !orig.parentId;
      })?.data.originalNode as MindMapNode;
    }

    const finalNodeId = existingNode?.id || nodeId;

    const newNode: MindMapNode = {
      id: finalNodeId,
      text: lineInfo.text,
      parentId: parentId || undefined,
      expanded: true,
      ...(existingNode ? {
        x: existingNode.x,
        y: existingNode.y,
        color: existingNode.color,
        backgroundColor: existingNode.backgroundColor,
        fontSize: existingNode.fontSize,
        shape: existingNode.shape,
        expanded: existingNode.expanded,
      } : {}),
    };

    newNodes.push(newNode);

    if (parentId) {
      const existingEdge = existingEdges.find(e => e.source === parentId && e.target === finalNodeId);
      if (existingEdge) {
        newEdges.push({
          id: existingEdge.id,
          source: parentId,
          target: finalNodeId,
          label: typeof existingEdge.label === 'string' ? existingEdge.label : undefined,
          color: (existingEdge.style as any)?.stroke,
          width: (existingEdge.style as any)?.strokeWidth,
        });
      } else {
        const edgeId = `edge_${parentId}_${finalNodeId}`;
        newEdges.push({
          id: edgeId,
          source: parentId,
          target: finalNodeId,
        });
      }
    }

    stack.push({ nodeId: finalNodeId, indent: lineInfo.indent });
  });

  return { nodes: newNodes, edges: newEdges, cards: [] };
};

// YAML 视图组件
const YamlView = ({
  nodes,
  edges,
  onSave,
  docId,
  isSaving,
}: {
  nodes: Node[];
  edges: Edge[];
  onSave: (nodes: MindMapNode[], edges: MindMapEdge[], cardsData?: Array<{ nodeId: string; cards: Card[] }>) => Promise<void>;
  docId: string;
  isSaving: boolean;
}) => {
  const [yamlText, setYamlText] = useState<string>('');
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitializedRef = useRef<boolean>(false);
  
  // AI 聊天相关状态
  const [showChat, setShowChat] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef<boolean>(true);
  
  // 打字机效果相关 ref
  const typingQueueRef = useRef<string>('');
  const typingTimerRef = useRef<number | null>(null);
  const isTypingRef = useRef<boolean>(false);
  
  // 面板大小调整相关状态
  const [chatPanelWidth, setChatPanelWidth] = useState<number>(30); // 百分比
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartWidthRef = useRef<number>(30);

  // 初始化 YAML 文本（在组件挂载时立即计算）
  const initialYaml = useMemo(() => {
    return convertNodesToYaml(nodes, edges);
  }, [nodes, edges]);

  // 初始化 YAML 文本状态
  useEffect(() => {
    if (!isInitializedRef.current) {
      setYamlText(initialYaml);
      setIsDirty(false);
    }
  }, [initialYaml]);

  // 初始化 Monaco Editor
  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;
    let model: any = null;
    
    const initEditor = async () => {
      try {
        const { load } = await import('vj/components/monaco/loader');
        const { monaco, registerAction } = await load(['yaml']);

        // 关闭 Monaco 默认的 YAML 校验，避免对自定义结构误报
        try {
          const yamlLanguages = (monaco.languages as any);
          yamlLanguages?.yaml?.yamlDefaults?.setDiagnosticsOptions?.({
            validate: false,
            enableSchemaRequest: false,
            hover: false,
            completion: false,
            format: false,
          });
        } catch (err) {
          console.warn('Failed to configure YAML diagnostics:', err);
        }

        if (!mounted || !containerRef.current) return;

        monacoRef.current = monaco;

        // 检查 model 是否已存在
        const modelUri = monaco.Uri.parse(`yaml://mindmap-${docId}.yaml`);
        model = monaco.editor.getModel(modelUri);
        
        // 使用初始 YAML 内容
        const initialContent = initialYaml || convertNodesToYaml(nodes, edges);
        
        if (model) {
          // 如果 model 已存在，更新内容
          model.setValue(initialContent);
        } else {
          // 创建新的 model
          model = monaco.editor.createModel(initialContent, 'yaml', modelUri);
        }

        // 如果编辑器已存在，只更新 model
        if (editorRef.current) {
          editorRef.current.setModel(model);
          editorRef.current.setValue(initialContent);
          return;
        }

        // 创建新的编辑器
        const editor = monaco.editor.create(containerRef.current, {
          model,
          theme: 'vs',
          language: 'yaml',
          automaticLayout: false, // 禁用自动布局，手动处理以避免 ResizeObserver 循环
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: 'on',
          wordWrap: 'on',
        });

        registerAction(editor, model);
        editorRef.current = editor;
        isInitializedRef.current = true;
        setYamlText(initialContent);

        // 手动处理布局更新，使用防抖避免频繁触发
        let layoutTimeout: NodeJS.Timeout | null = null;
        const updateLayout = () => {
          if (layoutTimeout) {
            clearTimeout(layoutTimeout);
          }
          layoutTimeout = setTimeout(() => {
            if (editor && editor.getDomNode() && editor.getDomNode().isConnected) {
              try {
                editor.layout();
              } catch (e) {
                // 忽略布局错误
              }
            }
          }, 50);
        };

        // 使用 ResizeObserver 手动监听容器大小变化
        let resizeObserver: ResizeObserver | null = null;
        if (containerRef.current) {
          resizeObserver = new ResizeObserver((entries) => {
            // 使用 requestAnimationFrame 来避免 ResizeObserver 循环
            requestAnimationFrame(() => {
              updateLayout();
            });
          });
          resizeObserver.observe(containerRef.current);
        }

        // 监听内容变化
        editor.onDidChangeModelContent(() => {
          const value = editor.getValue();
          setYamlText(value);
          setIsDirty(true);
        });

        // 保存快捷键 (Ctrl+S / Cmd+S) - 在编辑器初始化时定义
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
          const currentYaml = editor.getValue();
          try {
            const parsed = parseYamlToNodes(currentYaml, nodes, edges);
            if (parsed.nodes.length === 0 && parsed.edges.length === 0) {
              Notification.error('YAML 解析结果为空，请检查格式');
              return;
            }
            await onSave(parsed.nodes, parsed.edges, parsed.cards);
            setIsDirty(false);
            Notification.success('保存成功');
          } catch (error: any) {
            Notification.error('保存失败: ' + (error.message || '未知错误'));
          }
        });

        // 清理函数
        return () => {
          if (resizeObserver) {
            resizeObserver.disconnect();
          }
          if (layoutTimeout) {
            clearTimeout(layoutTimeout);
          }
        };

        registerAction(editor, model);
        editorRef.current = editor;
        isInitializedRef.current = true;
        setYamlText(initialContent);

        // 监听内容变化
        editor.onDidChangeModelContent(() => {
          const value = editor.getValue();
          setYamlText(value);
          setIsDirty(true);
        });

        // 保存快捷键 (Ctrl+S / Cmd+S) - 在编辑器初始化时定义
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
          const currentYaml = editor.getValue();
          try {
            const parsed = parseYamlToNodes(currentYaml, nodes, edges);
            if (parsed.nodes.length === 0 && parsed.edges.length === 0) {
              Notification.error('YAML 解析结果为空，请检查格式');
              return;
            }
            await onSave(parsed.nodes, parsed.edges, parsed.cards);
            setIsDirty(false);
            Notification.success('保存成功');
          } catch (error: any) {
            Notification.error('保存失败: ' + (error.message || '未知错误'));
          }
        });
      } catch (error: any) {
        console.error('Failed to initialize Monaco Editor:', error);
        Notification.error('初始化编辑器失败: ' + (error.message || '未知错误'));
      }
    };

    initEditor();

    return () => {
      mounted = false;
      // 注意：不要在这里销毁 model，因为 model 可能被多个编辑器实例共享
      // 只在组件完全卸载时清理编辑器
      if (editorRef.current && !isInitializedRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, [docId]); // 只在 docId 变化时重新初始化

  // 更新编辑器内容（当外部节点变化时，且用户未编辑）
  useEffect(() => {
    if (editorRef.current && !isDirty && isInitializedRef.current) {
      const newYaml = convertNodesToYaml(nodes, edges);
      const currentValue = editorRef.current.getValue();
      if (currentValue !== newYaml) {
        // 使用 pushEditOperations 来避免触发 change 事件
        const model = editorRef.current.getModel();
        if (model) {
          model.pushEditOperations(
            [],
            [{
              range: model.getFullModelRange(),
              text: newYaml,
            }],
            () => null
          );
          setYamlText(newYaml);
          setIsDirty(false);
        }
      }
    }
  }, [nodes, edges, isDirty]);

  const handleSave = useCallback(async () => {
    try {
      const currentYaml = editorRef.current?.getValue() || yamlText;
      const parsed = parseYamlToNodes(currentYaml, nodes, edges);
      if (parsed.nodes.length === 0 && parsed.edges.length === 0) {
        Notification.error('YAML 解析结果为空，请检查格式');
        return;
      }
      await onSave(parsed.nodes, parsed.edges, parsed.cards);
      setIsDirty(false);
      Notification.success('保存成功');
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
    }
  }, [yamlText, nodes, edges, onSave]);

  // 监听滚动事件，检测用户是否在底部
  useEffect(() => {
    const container = chatMessagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const threshold = 100; // 距离底部 100px 内认为在底部
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
      shouldAutoScrollRef.current = isNearBottom;
    };

    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [showChat]);

  // AI 聊天相关功能
  useEffect(() => {
    // 检查是否应该自动滚动（用户是否在底部附近）
    const checkShouldAutoScroll = () => {
      if (!chatMessagesContainerRef.current) return true;
      const container = chatMessagesContainerRef.current;
      const threshold = 100; // 距离底部 100px 内认为在底部
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
      return isNearBottom;
    };

    shouldAutoScrollRef.current = checkShouldAutoScroll();

    // 只在应该自动滚动时才滚动，并且只滚动容器内部，不滚动整个页面
    if (shouldAutoScrollRef.current && chatMessagesContainerRef.current && chatMessagesEndRef.current) {
      const container = chatMessagesContainerRef.current;
      // 直接设置容器的 scrollTop，而不是使用 scrollIntoView（会滚动整个页面）
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }, [chatMessages, showChat]);

  // 打字机效果：逐字显示内容
  const processTypingQueue = useCallback((messageIndex: number) => {
    if (!isTypingRef.current || typingQueueRef.current.length === 0) {
      isTypingRef.current = false;
      return;
    }

    const char = typingQueueRef.current[0];
    typingQueueRef.current = typingQueueRef.current.slice(1);

    setChatMessages(prev => {
      const newMessages = [...prev];
      if (newMessages[messageIndex]) {
        newMessages[messageIndex] = {
          ...newMessages[messageIndex],
          content: newMessages[messageIndex].content + char,
        };
      }
      return newMessages;
    });

    // 只在应该自动滚动时才滚动，并且只滚动容器内部，不滚动整个页面
    if (shouldAutoScrollRef.current && chatMessagesContainerRef.current) {
      const container = chatMessagesContainerRef.current;
      // 直接设置容器的 scrollTop，而不是使用 scrollIntoView（会滚动整个页面）
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }

    const delay = /[\u4e00-\u9fa5，。！？；：]/.test(char) ? 30 : 20;
    typingTimerRef.current = window.setTimeout(() => {
      processTypingQueue(messageIndex);
    }, delay);
  }, []);

  const addToTypingQueue = useCallback((content: string, messageIndex: number) => {
    typingQueueRef.current += content;
    
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      processTypingQueue(messageIndex);
    }
  }, [processTypingQueue]);

  const handleChatSend = useCallback(async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage = chatInput.trim();
    setChatInput('');
    setIsChatLoading(true);

    // 先添加用户消息和临时的assistant消息
    let assistantMessageIndex: number;
    setChatMessages(prev => {
      const newMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [...prev, { role: 'user' as const, content: userMessage }];
      // 添加一个临时的assistant消息用于流式更新
      assistantMessageIndex = newMessages.length; // assistant消息的索引
      newMessages.push({ role: 'assistant' as const, content: '' });
      return newMessages;
    });

    // 用户发送新消息时，应该自动滚动到底部
    shouldAutoScrollRef.current = true;

    // 清空打字机队列
    typingQueueRef.current = '';
    isTypingRef.current = false;
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    // 获取当前 YAML 内容
    const currentYaml = editorRef.current?.getValue() || yamlText;

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      const history = chatMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // 构建系统提示，让 AI 理解 YAML 结构
      const systemPrompt = `你是一个思维导图架构生成助手，专门负责帮助用户生成和优化思维导图的整体架构。

【你的核心职责】
1. **架构生成**：根据用户的需求，设计清晰、层次合理的节点结构
2. **结构优化**：帮助用户重构或整理现有节点，使其逻辑一致
3. **节点组织**：指导如何安排父子节点的层级关系
4. **卡片管理**：在合适的节点下添加、修改或删除卡片信息

【YAML 格式说明】
- 叶子节点：\`- 节点名称\`
- 有子节点或卡片时：\`- 节点名称:\`，随后使用额外缩进的列表描述内容
- 子节点使用额外的 \`- 子节点\` 表示

示例：
\`\`\`yaml
- recipe:
    - 咖喱:
        - 泰式
        - cards:
            - title: 绿咖喱介绍
              content: |
                这是卡片内容
                可以多行
        - 日式
    - 咖啡:
        - cards:
            - title: 基础配方
- 独立主题
\`\`\`

说明：
1. \`cards\` 以 \`- cards:\` 的形式作为节点内的特殊条目
2. \`cards\` 列表中的元素可以是纯字符串（仅标题）或带有 \`title\`、\`content\` 的对象
3. 子节点与 \`cards\` 条目同级，顺序任意
4. 缩进统一使用 2 个空格，保持 YAML 合法

【重要规则】
1. 只输出 YAML 代码块（\`\`\`yaml ... \`\`\`）
2. 不要添加多余说明文字
3. 优先考虑整体架构的合理性，再补充细节
4. 若需卡片，使用 \`- cards:\` 结构，并在内部列出卡片

当前 YAML 内容：
\`\`\`yaml
${yamlText}
\`\`\`

用户指令：`;

      const response = await fetch(`/d/${domainId}/ai/chat?stream=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `${systemPrompt}\n\n用户指令：${userMessage}`,
          history,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '请求失败' }));
        throw new Error(errorData.error || '请求失败');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';

      if (!reader) {
        throw new Error('无法读取响应流');
      }

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;

        if (value) {
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          if (!line.startsWith('data: ')) continue;
          
          try {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            
            const data = JSON.parse(jsonStr);
            
            if (data.type === 'content') {
              accumulatedContent += data.content;
              addToTypingQueue(data.content, assistantMessageIndex);
            } else if (data.type === 'done') {
              // 确保所有内容都显示完毕
              const checkAndFinalize = () => {
                if (typingQueueRef.current.length === 0) {
                  setChatMessages(prev => {
                    const newMessages = [...prev];
                    if (newMessages[assistantMessageIndex]) {
                      const finalContent = data.content || accumulatedContent;
                      const currentContent = newMessages[assistantMessageIndex].content;
                      if (currentContent !== finalContent) {
                        const missing = finalContent.slice(currentContent.length);
                        if (missing) {
                          newMessages[assistantMessageIndex] = {
                            role: 'assistant',
                            content: finalContent,
                          };
                        }
                      }
                    }
                    return newMessages;
                  });
                  
                  isTypingRef.current = false;
                  if (typingTimerRef.current) {
                    clearTimeout(typingTimerRef.current);
                    typingTimerRef.current = null;
                  }

                  // 尝试从 AI 回复中提取 YAML 代码块
                  const finalContent = data.content || accumulatedContent;
                  const yamlMatch = finalContent.match(/```(?:yaml)?\n([\s\S]*?)\n```/);
                  if (yamlMatch) {
                    const newYaml = yamlMatch[1].trim();
                    if (editorRef.current && newYaml) {
                      editorRef.current.setValue(newYaml);
                      setYamlText(newYaml);
                      setIsDirty(true);
                      Notification.success('AI 已更新 YAML 内容');
                    }
                  } else {
                    // 如果没有代码块，检查是否整个回复都是 YAML 格式
                    const lines = finalContent.split('\n');
                    const firstLine = lines[0]?.trim();
                    if (firstLine && firstLine.startsWith('-')) {
                      // 可能是纯 YAML，尝试使用
                      if (editorRef.current) {
                        editorRef.current.setValue(finalContent.trim());
                        setYamlText(finalContent.trim());
                        setIsDirty(true);
                        Notification.success('AI 已更新 YAML 内容');
                      }
                    }
                  }
                } else {
                  setTimeout(checkAndFinalize, 100);
                }
              };
              
              if (typingQueueRef.current.length === 0) {
                checkAndFinalize();
              } else {
                setTimeout(checkAndFinalize, 100);
              }
              
              break;
            } else if (data.type === 'error') {
              throw new Error(data.error || '请求失败');
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    } catch (error: any) {
      setChatMessages(prev => {
        const newMessages = [...prev];
        if (newMessages[assistantMessageIndex]) {
          newMessages[assistantMessageIndex] = {
            role: 'assistant',
            content: `错误: ${error.message || '未知错误'}`,
          };
        }
        return newMessages;
      });
      Notification.error('AI 聊天失败: ' + (error.message || '未知错误'));
    } finally {
      setIsChatLoading(false);
    }
  }, [chatInput, isChatLoading, chatMessages, yamlText, addToTypingQueue]);

  // 处理拖拽开始
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = chatPanelWidth;
  }, [chatPanelWidth]);

  // 处理拖拽过程
  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const deltaX = resizeStartXRef.current - e.clientX; // 向左拖拽时 deltaX 为正
      const containerWidth = window.innerWidth;
      const deltaPercent = (deltaX / containerWidth) * 100;
      const newWidth = Math.max(20, Math.min(60, resizeStartWidthRef.current + deltaPercent));
      setChatPanelWidth(newWidth);
      
      // 手动触发编辑器布局更新，使用 requestAnimationFrame 避免 ResizeObserver 循环
      requestAnimationFrame(() => {
        if (editorRef.current) {
          try {
            editorRef.current.layout();
          } catch (e) {
            // 忽略布局错误
          }
        }
      });
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
      // 拖拽结束后再次更新布局
      requestAnimationFrame(() => {
        if (editorRef.current) {
          try {
            editorRef.current.layout();
          } catch (e) {
            // 忽略布局错误
          }
        }
      });
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', width: '100%' }}>
      {/* 主编辑区域 */}
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        height: '100%', 
        width: showChat ? `${100 - chatPanelWidth}%` : '100%', 
        transition: isResizing ? 'none' : 'width 0.3s ease' 
      }}>
        {/* 工具栏 */}
        <div style={{
          padding: '10px 20px',
          background: '#f5f5f5',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <button
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            style={{
              padding: '8px 16px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: isSaving || !isDirty ? '#f5f5f5' : '#4caf50',
              color: isSaving || !isDirty ? '#999' : '#fff',
              cursor: isSaving || !isDirty ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
            }}
          >
            {isSaving ? '保存中...' : '保存 (Ctrl+S)'}
          </button>
          {isDirty && (
            <span style={{ color: '#ff9800', fontSize: '14px' }}>● 未保存的更改</span>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <button
              onClick={() => setShowChat(!showChat)}
              style={{
                padding: '8px 16px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                background: showChat ? '#2196f3' : '#fff',
                color: showChat ? '#fff' : '#333',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              {showChat ? '隐藏 AI' : '显示 AI'}
            </button>
          </div>
        </div>
        {/* 编辑器容器 */}
        <div ref={containerRef} style={{ flex: 1, width: '100%' }} />
      </div>

      {/* 分隔条 */}
      {showChat && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            width: '4px',
            height: '100%',
            background: isResizing ? '#2196f3' : '#ddd',
            cursor: 'col-resize',
            position: 'relative',
            flexShrink: 0,
            transition: isResizing ? 'none' : 'background 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (!isResizing) {
              e.currentTarget.style.background = '#bbb';
            }
          }}
          onMouseLeave={(e) => {
            if (!isResizing) {
              e.currentTarget.style.background = '#ddd';
            }
          }}
        >
          <div style={{
            position: 'absolute',
            left: '-2px',
            top: 0,
            width: '8px',
            height: '100%',
            cursor: 'col-resize',
          }} />
        </div>
      )}

      {/* AI 聊天面板 */}
      {showChat && (
        <div style={{
          width: `${chatPanelWidth}%`,
          height: '100%',
          borderLeft: '1px solid #ddd',
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          transition: isResizing ? 'none' : 'width 0.3s ease',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid #ddd',
            background: '#f5f5f5',
            fontWeight: 'bold',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span>AI 助手</span>
            <button
              onClick={() => setShowChat(false)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer',
                color: '#999',
              }}
            >
              &times;
            </button>
          </div>
          
          <div 
            ref={chatMessagesContainerRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {chatMessages.length === 0 && (
              <div style={{
                textAlign: 'center',
                color: '#999',
                padding: '20px',
                fontSize: '14px',
              }}>
                <p>你好！我是 AI 助手，可以帮助你编辑 YAML。</p>
                <p style={{ marginTop: '8px', fontSize: '12px' }}>例如：</p>
                <ul style={{ textAlign: 'left', marginTop: '8px', fontSize: '12px', color: '#666' }}>
                  <li>"添加一个名为 '新节点' 的子节点到 Root"</li>
                  <li>"删除 'Ancient' 节点"</li>
                  <li>"将 'CT-辅助' 重命名为 'CT辅助'"</li>
                </ul>
              </div>
            )}
            {chatMessages.map((msg, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: msg.role === 'user' ? '#2196f3' : '#f5f5f5',
                  color: msg.role === 'user' ? '#fff' : '#333',
                  maxWidth: '85%',
                  fontSize: '14px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {msg.content}
                </div>
              </div>
            ))}
            {isChatLoading && (
              <div style={{
                padding: '8px 12px',
                borderRadius: '8px',
                background: '#f5f5f5',
                color: '#999',
                fontSize: '14px',
              }}>
                正在思考...
              </div>
            )}
            <div ref={chatMessagesEndRef} />
          </div>

          <div style={{
            padding: '12px',
            borderTop: '1px solid #ddd',
            background: '#f5f5f5',
          }}>
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleChatSend();
                }
              }}
              placeholder="输入消息... (Shift+Enter换行，Enter发送)"
              rows={3}
              disabled={isChatLoading}
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px',
                resize: 'none',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={handleChatSend}
              disabled={!chatInput.trim() || isChatLoading}
              style={{
                marginTop: '8px',
                width: '100%',
                padding: '8px',
                border: 'none',
                borderRadius: '4px',
                background: (!chatInput.trim() || isChatLoading) ? '#ccc' : '#2196f3',
                color: '#fff',
                cursor: (!chatInput.trim() || isChatLoading) ? 'not-allowed' : 'pointer',
                fontWeight: 'bold',
              }}
            >
              发送
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// 辅助函数：获取带 domainId 的 mindmap URL
const getMindMapUrl = (path: string, docId: string): string => {
  const domainId = (window as any).UiContext?.domainId || 'system';
  return `/d/${domainId}/mindmap/${docId}${path}`;
};

const page = new NamedPage('mindmap_detail', async () => {
  try {
    const $container = $('#mindmap-editor');
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
      <MindMapEditor docId={docId} initialData={initialData} />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize mindmap editor:', error);
    Notification.error('初始化思维导图编辑器失败: ' + (error.message || '未知错误'));
  }
});

export default page;


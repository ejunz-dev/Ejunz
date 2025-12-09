import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import Editor from 'vj/components/editor';
import { Dialog } from 'vj/components/dialog/index';

interface MindMapNode {
  id: string;
  text: string;
  x?: number;
  y?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  order?: number; // 节点顺序
}

interface MindMapEdge {
  id: string;
  source: string;
  target: string;
}

interface MindMapDoc {
  docId: string;
  mmid: number;
  title: string;
  content: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
  currentBranch?: string;
  files?: Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>;
}

interface CardProblem {
  pid: string;
  type: 'single';
  stem: string;
  options: string[];
  answer: number; // 正确选项在 options 中的下标
  analysis?: string;
}

interface Card {
  docId: string;
  cid: number;
  title: string;
  content: string;
  updateAt: string;
  createdAt?: string;
  order?: number;
  nodeId?: string; // 卡片所属的节点ID（可能被拖动修改）
  problems?: CardProblem[]; // 本卡片关联的练习题
}

type FileItem = {
  type: 'node' | 'card';
  id: string;
  name: string;
  nodeId?: string;
  cardId?: string;
  parentId?: string;
  level: number;
  hasPendingChanges?: boolean; // 是否有未保存的更改
  clipboardType?: 'copy' | 'cut'; // 是否被复制/剪切
};

interface PendingChange {
  file: FileItem;
  content: string;
  originalContent: string;
}

interface PendingRename {
  file: FileItem;
  newName: string;
  originalName: string;
}

interface PendingCreate {
  type: 'card' | 'node';
  nodeId: string; // 对于 card，是所属节点；对于 node，是父节点
  title?: string; // card 的标题
  text?: string; // node 的文本
  tempId: string; // 临时 ID，用于前端显示
}

interface PendingDelete {
  type: 'card' | 'node';
  id: string; // cardId 或 nodeId
  nodeId?: string; // 对于 card，记录所属节点
}

// 排序窗口组件
function SortWindow({ 
  nodeId, 
  mindMap, 
  docId,
  getMindMapUrl,
  onClose, 
  onSave,
  nodeCardsMapVersion
}: { 
  nodeId: string; 
  mindMap: MindMapDoc; 
  docId: string;
  getMindMapUrl: (path: string, docId: string) => string;
  onClose: () => void; 
  onSave: (sortedItems: Array<{ type: 'node' | 'card'; id: string; order: number }>) => Promise<void>;
  nodeCardsMapVersion?: number; // 用于触发重新计算cards
}) {
  const [draggedItem, setDraggedItem] = useState<{ type: 'node' | 'card'; id: string; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  // 获取子节点（按order排序，包含临时节点）
  const childNodes = useMemo(() => {
    return mindMap.edges
      .filter(e => e.source === nodeId)
      .map(e => {
        const node = mindMap.nodes.find(n => n.id === e.target);
        return node ? { 
          id: node.id, 
          name: node.text || '未命名节点',
          order: node.order || 0,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; name: string; order: number }>;
  }, [mindMap.edges, mindMap.nodes, nodeId]);
  
  // 获取卡片（按order排序，包含临时卡片）
  const cards = useMemo(() => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || [])
      .filter((card: Card) => !card.nodeId || card.nodeId === nodeId)
      .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    return nodeCards.map((card: Card) => ({
      id: card.docId,
      name: card.title || '未命名卡片',
      order: card.order || 0,
    }));
  }, [nodeId, nodeCardsMapVersion]); // 添加nodeCardsMapVersion依赖，确保能响应nodeCardsMap的变化
  
  // 合并的列表，按照order混合排序（node和card混合在一起）
  const [items, setItems] = useState<Array<{ type: 'node' | 'card'; id: string; name: string; order: number }>>(() => {
    const allItems: Array<{ type: 'node' | 'card'; id: string; name: string; order: number }> = [
      ...childNodes.map(n => ({ type: 'node' as const, id: n.id, name: n.name, order: n.order })),
      ...cards.map(c => ({ type: 'card' as const, id: c.id, name: c.name, order: c.order })),
    ];
    // 按order排序
    return allItems.sort((a, b) => (a.order || 0) - (b.order || 0));
  });
  
  // 当childNodes或cards变化时更新items
  useEffect(() => {
    const allItems: Array<{ type: 'node' | 'card'; id: string; name: string; order: number }> = [
      ...childNodes.map(n => ({ type: 'node' as const, id: n.id, name: n.name, order: n.order })),
      ...cards.map(c => ({ type: 'card' as const, id: c.id, name: c.name, order: c.order })),
    ];
    // 按order排序
    setItems(allItems.sort((a, b) => (a.order || 0) - (b.order || 0)));
  }, [childNodes, cards]);
  
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedItem({ type: items[index].type, id: items[index].id, index });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', '');
  };
  
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedItem && draggedItem.index !== index) {
      setDragOverIndex(index);
    }
  };
  
  const handleDragLeave = () => {
    setDragOverIndex(null);
  };
  
  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.index === index) {
      setDragOverIndex(null);
      setDraggedItem(null);
      return;
    }
    
    const newItems = [...items];
    const [removed] = newItems.splice(draggedItem.index, 1);
    newItems.splice(index, 0, removed);
    setItems(newItems);
    
    setDragOverIndex(null);
    setDraggedItem(null);
  };
  
  const handleDragEnd = () => {
    setDragOverIndex(null);
    setDraggedItem(null);
  };
  
  const handleSave = async () => {
    // 按照当前items的顺序，为每个item分配order（从1开始）
    const sortedItems: Array<{ type: 'node' | 'card'; id: string; order: number }> = [];
    
    for (let i = 0; i < items.length; i++) {
      sortedItems.push({
        type: items[i].type,
        id: items[i].id,
        order: i + 1,
      });
    }
    
    await onSave(sortedItems);
  };
  
  const currentNode = mindMap.nodes.find(n => n.id === nodeId);
  
  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            backgroundColor: '#fff',
            borderRadius: '8px',
            padding: '20px',
            minWidth: '500px',
            maxWidth: '80%',
            maxHeight: '80%',
            overflow: 'auto',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>
              排序: {currentNode?.text || '未命名节点'}
            </h3>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                color: '#666',
                padding: '0',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
          
          <div style={{ marginBottom: '16px', fontSize: '13px', color: '#666' }}>
            拖拽项目以改变顺序
          </div>
          
          <div style={{ marginBottom: '16px' }}>
            {items.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                暂无子节点和卡片
              </div>
            ) : (
              items.map((item, index) => (
                <div
                  key={`${item.type}-${item.id}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  style={{
                    padding: '12px',
                    marginBottom: '8px',
                    backgroundColor: dragOverIndex === index ? '#e3f2fd' : draggedItem?.index === index ? '#f5f5f5' : '#fff',
                    border: '1px solid #e1e4e8',
                    borderRadius: '4px',
                    cursor: 'move',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    opacity: draggedItem?.index === index ? 0.5 : 1,
                    transition: 'background-color 0.2s',
                  }}
                >
                  <div style={{ fontSize: '18px', color: '#999' }}>⋮⋮</div>
                  <div style={{ 
                    padding: '2px 8px', 
                    borderRadius: '3px', 
                    fontSize: '12px',
                    backgroundColor: item.type === 'node' ? '#2196f3' : '#4caf50',
                    color: '#fff',
                    fontWeight: '500',
                  }}>
                    {item.type === 'node' ? 'Node' : 'Card'}
                  </div>
                  <div style={{ flex: 1, fontSize: '14px', color: '#24292e' }}>
                    {item.name}
                  </div>
                </div>
              ))
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              onClick={onClose}
              style={{
                padding: '6px 16px',
                border: '1px solid #d1d5da',
                borderRadius: '4px',
                backgroundColor: '#fff',
                color: '#24292e',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              取消
            </button>
            <button
              onClick={handleSave}
              style={{
                padding: '6px 16px',
                border: '1px solid #28a745',
                borderRadius: '4px',
                backgroundColor: '#28a745',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '500',
              }}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// 迁移函数：为没有order字段的node和card分配order
// 返回迁移后的mindMap和是否需要保存的标志
function migrateOrderFields(mindMap: MindMapDoc): { mindMap: MindMapDoc; needsSave: boolean; cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> } {
  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
  let needsSave = false;
  const cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> = [];
  
  // 检查nodes是否需要迁移
  const nodesNeedMigration = mindMap.nodes.some(node => node.order === undefined);
  
  // 检查cards是否需要迁移
  let cardsNeedMigration = false;
  for (const nodeId in nodeCardsMap) {
    const cards = nodeCardsMap[nodeId] || [];
    if (cards.some((card: Card) => card.order === undefined)) {
      cardsNeedMigration = true;
      break;
    }
  }
  
  if (!nodesNeedMigration && !cardsNeedMigration) {
    return { mindMap, needsSave: false, cardUpdates: [] };
  }
  
  needsSave = true;
  
  // 创建节点映射
  const nodeMap = new Map<string, MindMapNode>();
  mindMap.nodes.forEach(node => {
    nodeMap.set(node.id, { ...node });
  });
  
  // 为每个节点的子节点分配order
  const processedNodes = new Set<string>();
  
  const assignOrderToChildren = (parentId: string) => {
    if (processedNodes.has(parentId)) return;
    processedNodes.add(parentId);
    
    // 获取该节点的所有子节点（按edges的顺序）
    const childEdges = mindMap.edges
      .filter(e => e.source === parentId)
      .map(e => {
        const node = nodeMap.get(e.target);
        return node ? { node, edge: e } : null;
      })
      .filter(Boolean) as Array<{ node: MindMapNode; edge: MindMapEdge }>;
    
    // 如果子节点需要迁移，按edges的顺序分配order
    if (childEdges.some(item => item.node.order === undefined)) {
      childEdges.forEach((item, index) => {
        if (item.node.order === undefined) {
          item.node.order = index + 1;
        }
      });
    }
    
    // 递归处理子节点
    childEdges.forEach(item => {
      assignOrderToChildren(item.node.id);
    });
  };
  
  // 找到根节点并开始迁移
  const rootNodes = mindMap.nodes.filter(node => 
    !mindMap.edges.some(edge => edge.target === node.id)
  );
  
  rootNodes.forEach(rootNode => {
    assignOrderToChildren(rootNode.id);
  });
  
  // 迁移cards的order
  for (const nodeId in nodeCardsMap) {
    const cards = nodeCardsMap[nodeId] || [];
    const cardsNeedOrder = cards.filter((card: Card) => card.order === undefined);
    
    if (cardsNeedOrder.length > 0) {
      // 获取已有order的最大值
      const maxOrder = cards
        .filter((card: Card) => card.order !== undefined)
        .reduce((max: number, card: Card) => Math.max(max, card.order || 0), 0);
      
      // 为没有order的card分配order
      cardsNeedOrder.forEach((card: Card, index: number) => {
        const newOrder = maxOrder + index + 1;
        card.order = newOrder;
        cardUpdates.push({
          cardId: card.docId,
          nodeId: nodeId,
          order: newOrder,
        });
      });
    }
  }
  
  // 更新nodeCardsMap
  if (cardsNeedMigration) {
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
  }
  
  // 返回更新后的mindMap
  return {
    mindMap: {
      ...mindMap,
      nodes: Array.from(nodeMap.values()),
    },
    needsSave,
    cardUpdates,
  };
}

function MindMapEditorMode({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  // 在初始化时迁移order字段
  const migrationResult = useMemo(() => migrateOrderFields(initialData), [initialData]);
  const [mindMap, setMindMap] = useState<MindMapDoc>(() => migrationResult.mindMap);
  
  // 如果需要进行迁移，自动保存
  useEffect(() => {
    if (migrationResult.needsSave) {
      const saveMigration = async () => {
        try {
          const domainId = (window as any).UiContext?.domainId || 'system';
          const getMindMapUrl = (path: string, docId: string): string => {
            return `/d/${domainId}/mindmap/${docId}${path}`;
          };
          
          // 保存nodes的order
          // 过滤掉临时节点和边，确保不会保存临时数据
          const migrationNodes = migrationResult.mindMap.nodes.filter(n => !n.id.startsWith('temp-node-'));
          const migrationEdges = migrationResult.mindMap.edges.filter(e => 
            !e.source.startsWith('temp-node-') && 
            !e.target.startsWith('temp-node-') &&
            !e.id.startsWith('temp-edge-')
          );
          
          await request.post(getMindMapUrl('/save', docId), {
            nodes: migrationNodes,
            edges: migrationEdges,
            operationDescription: '自动迁移：为节点和卡片添加order字段',
          });
          
          // 批量更新cards的order
          if (migrationResult.cardUpdates.length > 0) {
            const updatePromises = migrationResult.cardUpdates.map(update =>
              request.post(`/d/${domainId}/mindmap/card/${update.cardId}`, {
                operation: 'update',
                nodeId: update.nodeId,
                order: update.order,
              })
            );
            await Promise.all(updatePromises);
          }
          
          console.log('Order字段迁移完成');
        } catch (error: any) {
          console.error('迁移order字段失败:', error);
          // 不显示错误提示，因为这是后台自动迁移
        }
      };
      
      saveMigration();
    }
  }, [migrationResult.needsSave, migrationResult.mindMap.nodes, migrationResult.mindMap.edges, migrationResult.cardUpdates, docId]);
  
  // 页面刷新时清空所有pending状态，确保不会有残留的临时数据
  useEffect(() => {
    pendingCreatesRef.current.clear();
    setPendingCreatesCount(0);
    setPendingChanges(new Map());
    setPendingRenames(new Map());
    setPendingDeletes(new Map());
    setPendingDragChanges(new Set());
  }, [docId]); // 当docId变化时（即切换到不同的mindmap时）清空
  
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  // 多选模式相关状态
  const [isMultiSelectMode, setIsMultiSelectMode] = useState<boolean>(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set()); // 选中的文件ID集合
  const getNodeChildrenRef = useRef<((nodeId: string, visited?: Set<string>) => { nodes: string[]; cards: string[] }) | null>(null);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [pendingRenames, setPendingRenames] = useState<Map<string, PendingRename>>(new Map());
  const pendingCreatesRef = useRef<Map<string, PendingCreate>>(new Map()); // 待创建的项目（使用 useRef，避免重新渲染导致状态不一致）
  const [pendingCreatesCount, setPendingCreatesCount] = useState<number>(0); // 用于触发重新渲染，跟踪pendingCreates的数量
  const [pendingDeletes, setPendingDeletes] = useState<Map<string, PendingDelete>>(new Map()); // 待删除的项目
  const originalContentsRef = useRef<Map<string, string>>(new Map());
  const [draggedFile, setDraggedFile] = useState<FileItem | null>(null);
  const [dragOverFile, setDragOverFile] = useState<FileItem | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'into'>('after');
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [pendingDragChanges, setPendingDragChanges] = useState<Set<string>>(new Set()); // 记录哪些卡片/节点被拖动过
  const [nodeCardsMapVersion, setNodeCardsMapVersion] = useState(0); // 用于触发 fileTree 重新计算
  const dragLeaveTimeoutRef = useRef<NodeJS.Timeout | null>(null); // 用于延迟清除 dragOverFile
  const dragOverTimeoutRef = useRef<NodeJS.Timeout | null>(null); // 用于节流 dragOver 更新
  const lastDragOverFileRef = useRef<FileItem | null>(null); // 上次悬停的文件
  const lastDropPositionRef = useRef<'before' | 'after' | 'into'>('after'); // 上次的放置位置
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem } | null>(null); // 右键菜单
  const [clipboard, setClipboard] = useState<{ type: 'copy' | 'cut'; items: FileItem[] } | null>(null); // 剪贴板（支持多个项目）
  const [sortWindow, setSortWindow] = useState<{ nodeId: string } | null>(null); // 排序窗口
  // AI 聊天相关状态
  const [showAIChat, setShowAIChat] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<Array<{ 
    role: 'user' | 'assistant' | 'operation'; 
    content: string; 
    references?: Array<{ type: 'node' | 'card'; id: string; name: string; path: string[] }>;
    operations?: any[];
    isExpanded?: boolean;
  }>>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatInputReferences, setChatInputReferences] = useState<Array<{ type: 'node' | 'card'; id: string; name: string; path: string[]; startIndex: number; endIndex: number }>>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesContainerRef = useRef<HTMLDivElement>(null);
  const [chatPanelWidth, setChatPanelWidth] = useState<number>(300); // 像素
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartWidthRef = useRef<number>(300);
  const executeAIOperationsRef = useRef<((operations: any[]) => Promise<{ success: boolean; errors: string[] }>) | null>(null);
  const chatWebSocketRef = useRef<any>(null); // WebSocket 连接
  const [explorerMode, setExplorerMode] = useState<'tree' | 'files' | 'pending'>('tree'); // 文件树模式、文件模式或待提交模式
  const [files, setFiles] = useState<Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>>(initialData.files || []);
  const [selectedFileForPreview, setSelectedFileForPreview] = useState<string | null>(null);
  // 单选题编辑状态（针对当前选中的卡片）
  const [problemStem, setProblemStem] = useState<string>('');
  const [problemOptions, setProblemOptions] = useState<string[]>(['', '', '', '']);
  const [problemAnswer, setProblemAnswer] = useState<number>(0);
  const [problemAnalysis, setProblemAnalysis] = useState<string>('');
  const [isSavingProblem, setIsSavingProblem] = useState<boolean>(false);
  const [showProblemForm, setShowProblemForm] = useState<boolean>(false); // 是否展开新建题目表单
  // 有题目变更但尚未提交的卡片（使用后端真实 cardId）
  const [pendingProblemCardIds, setPendingProblemCardIds] = useState<Set<string>>(new Set());

  // 获取当前选中卡片的完整信息（包括 problems）
  const getSelectedCard = useCallback((): Card | null => {
    if (!selectedFile || selectedFile.type !== 'card') return null;
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[selectedFile.nodeId || ''] || [];
    const card = nodeCards.find((c: Card) => c.docId === selectedFile.cardId);
    return card || null;
  }, [selectedFile]);

  // 当选中的卡片变化时，重置题目编辑表单
  useEffect(() => {
    setProblemStem('');
    setProblemOptions(['', '', '', '']);
    setProblemAnswer(0);
    setProblemAnalysis('');
    setShowProblemForm(false);
  }, [selectedFile?.id]);
  
  // 当 mindMap.files 变化时更新 files 状态
  useEffect(() => {
    if (mindMap.files) {
      setFiles(mindMap.files);
    }
  }, [mindMap.files]);
  
  // 从节点的 expanded 字段读取展开状态
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const initialExpanded = new Set<string>();
    // 在组件初始化时，根据节点的 expanded 字段决定是否展开
    // expanded 为 undefined 或 true 时展开，为 false 时折叠
    if (initialData?.nodes) {
      initialData.nodes.forEach(node => {
        if (node.expanded !== false) {
          initialExpanded.add(node.id);
        }
      });
    }
    return initialExpanded;
  }); // 记录展开的节点
  
  // 自动保存定时器 ref
  const expandSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  // 保存最新的展开状态 ref，用于自动保存时获取最新值
  const expandedNodesRef = useRef<Set<string>>(expandedNodes);
  // 保存最新的 mindMap ref，用于自动保存时获取最新值
  const mindMapRef = useRef<MindMapDoc>(mindMap);
  
  // 同步 refs
  useEffect(() => {
    expandedNodesRef.current = expandedNodes;
  }, [expandedNodes]);
  
  useEffect(() => {
    mindMapRef.current = mindMap;
  }, [mindMap]);
  
  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (expandSaveTimerRef.current) {
        clearTimeout(expandSaveTimerRef.current);
        expandSaveTimerRef.current = null;
      }
    };
  }, []);

  // 获取带 domainId 的 mindmap URL
  const getMindMapUrl = (path: string, docId: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    return `/d/${domainId}/mindmap/${docId}${path}`;
  };

  // 构建文件树（支持折叠）
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
    
    // 为每个节点的子节点按照order排序
    nodeMap.forEach((nodeData) => {
      nodeData.children.sort((a, b) => {
        const nodeA = mindMap.nodes.find(n => n.id === a);
        const nodeB = mindMap.nodes.find(n => n.id === b);
        const orderA = nodeA?.order || 0;
        const orderB = nodeB?.order || 0;
        return orderA - orderB;
      });
    });

    // 找到根节点
    mindMap.nodes.forEach((node) => {
      const hasParent = mindMap.edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });

    // 获取最新的 nodeCardsMap（从 UiContext 或本地状态）
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    
    // 获取待删除的项目 ID 集合
    const deletedNodeIds = new Set(
      Array.from(pendingDeletes.values())
        .filter(d => d.type === 'node')
        .map(d => d.id)
    );
    const deletedCardIds = new Set(
      Array.from(pendingDeletes.values())
        .filter(d => d.type === 'card')
        .map(d => d.id)
    );

    // 检查节点及其所有祖先节点是否被移动
    const checkAncestorMoved = (nodeId: string): boolean => {
      // 检查当前节点是否被移动
      if (pendingDragChanges.has(`node-${nodeId}`)) return true;
      
      // 找到当前节点的父节点
      const parentEdge = mindMap.edges.find(e => e.target === nodeId);
      if (parentEdge) {
        // 递归检查父节点
        return checkAncestorMoved(parentEdge.source);
      }
      
      return false;
    };

    // 检查项目是否在剪贴板中
    const checkClipboard = (file: { type: 'node' | 'card'; id: string; nodeId?: string; cardId?: string }): 'copy' | 'cut' | undefined => {
      if (!clipboard) return undefined;
      
      const found = clipboard.items.find(item => {
        if (file.type === 'node') {
          return item.type === 'node' && item.nodeId === file.nodeId;
        } else if (file.type === 'card') {
          return item.type === 'card' && item.cardId === file.cardId;
        }
        return false;
      });
      
      return found ? clipboard.type : undefined;
    };

    // 检查项目是否有未保存的更改
    const checkPendingChanges = (file: { type: 'node' | 'card'; id: string; nodeId?: string; cardId?: string; parentId?: string }): boolean => {
      // 检查内容修改
      if (pendingChanges.has(file.id)) return true;
      
      // 检查重命名
      if (pendingRenames.has(file.id)) return true;
      
      // 检查新建（临时 ID）
      // 对于 node，id 直接是 temp-node-...
      // 对于 card，id 是 card-temp-card-...，需要检查 cardId 或 id
      if (file.id.startsWith('temp-') || 
          (file.type === 'card' && file.cardId && file.cardId.startsWith('temp-')) ||
          (file.type === 'card' && file.id.startsWith('card-temp-')) ||
          Array.from(pendingCreatesRef.current.values()).some(c => {
            // 对于 node，只有当 file.id 是 tempId 时才匹配（真实节点ID不会匹配临时ID）
            if (file.type === 'node' && c.type === 'node' && c.tempId === file.id) return true;
            // 对于 card，file.id 是 card-${cardId}，需要匹配
            if (file.type === 'card' && c.type === 'card' && file.id === `card-${c.tempId}`) return true;
            return false;
          })) return true;
      
      // 检查移动
      if (file.type === 'node' && file.nodeId) {
        // 检查节点本身是否被移动
        if (pendingDragChanges.has(`node-${file.nodeId}`)) return true;
        // 检查节点的任何祖先节点是否被移动
        if (checkAncestorMoved(file.nodeId)) return true;
      } else if (file.type === 'card') {
        // 检查卡片本身是否被移动
        if (file.cardId && pendingDragChanges.has(file.cardId)) return true;
        // 检查卡片所属节点及其祖先节点是否被移动
        if (file.nodeId && checkAncestorMoved(file.nodeId)) return true;
      }
      
      return false;
    };

    // 递归构建文件树（只显示展开的节点）
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      // 如果节点被删除，跳过
      if (deletedNodeIds.has(nodeId)) return;
      
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node } = nodeData;
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
      nodeFileItem.hasPendingChanges = checkPendingChanges(nodeFileItem);
      nodeFileItem.clipboardType = checkClipboard(nodeFileItem);
      items.push(nodeFileItem);

      // 如果节点展开，显示其卡片和子节点（按order混合排序）
      if (isExpanded) {
        // 获取该节点的卡片（按 order 排序）
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            // 检查卡片是否属于当前节点（如果 card.nodeId 存在，使用它；否则假设属于当前节点）
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        // 获取子节点（按 order 排序）
        const childNodes = nodeData.children
          .map(childId => {
            const childNode = mindMap.nodes.find(n => n.id === childId);
            return childNode ? { id: childId, node: childNode, order: childNode.order || 0 } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: MindMapNode; order: number }>;
        
        // 合并node和card，按照order混合排序
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
            // 跳过待删除的卡片
            if (deletedCardIds.has(card.docId)) return;
            
            const cardFileItem: FileItem = {
              type: 'card',
              id: `card-${card.docId}`,
              name: card.title || '未命名卡片',
              nodeId: card.nodeId || nodeId,
              cardId: card.docId,
              parentId: card.nodeId || nodeId,
              level: level + 1,
            };
            cardFileItem.hasPendingChanges = checkPendingChanges(cardFileItem);
            cardFileItem.clipboardType = checkClipboard(cardFileItem);
            items.push(cardFileItem);
          } else {
            // 递归处理子节点
            buildTree(item.id, level + 1, nodeId);
          }
        });
        
        // 添加待创建的卡片（临时显示，放在最后）
        // 只显示那些不在 nodeCardsMap 中的卡片（避免重复）
        const existingCardIds = new Set((nodeCardsMap[nodeId] || []).map((c: Card) => c.docId));
        Array.from(pendingCreatesRef.current.values())
          .filter(c => c.type === 'card' && c.nodeId === nodeId && !existingCardIds.has(c.tempId))
          .forEach(create => {
            const createFileItem: FileItem = {
              type: 'card',
              id: create.tempId,
              name: create.title || '新卡片',
              nodeId: nodeId,
              cardId: create.tempId,
              parentId: nodeId,
              level: level + 1,
            };
            createFileItem.hasPendingChanges = true; // 新建的项目肯定有未保存的更改
            items.push(createFileItem);
          });
        
        // 添加待创建的节点（临时显示，放在最后）
        // 只显示那些不在 mindMap.nodes 中的节点（避免重复）
        const existingNodeIds = new Set(mindMap.nodes.map(n => n.id));
        Array.from(pendingCreatesRef.current.values())
          .filter(c => c.type === 'node' && c.nodeId === nodeId && !existingNodeIds.has(c.tempId))
          .forEach(create => {
            // 递归构建待创建的节点及其子树
            const createFileItem: FileItem = {
              type: 'node',
              id: create.tempId,
              name: create.text || '新节点',
              nodeId: create.tempId,
              parentId: nodeId,
              level: level + 1,
            };
            createFileItem.hasPendingChanges = true; // 新建的项目肯定有未保存的更改
            items.push(createFileItem);
            // 如果节点展开，递归构建其子树（但待创建的节点默认不展开）
            // 注意：待创建的节点不会有子节点，因为它们还没有保存到后端
          });
      }
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });
    
    // 添加待创建的根节点（临时显示，放在最后）
    // 只显示那些不在 mindMap.nodes 中的节点（避免重复）
    const existingNodeIds = new Set(mindMap.nodes.map(n => n.id));
    Array.from(pendingCreatesRef.current.values())
      .filter(c => c.type === 'node' && !c.nodeId && !existingNodeIds.has(c.tempId))
      .forEach(create => {
        const createFileItem: FileItem = {
          type: 'node',
          id: create.tempId,
          name: create.text || '新节点',
          nodeId: create.tempId,
          level: 0,
        };
        createFileItem.hasPendingChanges = true; // 新建的项目肯定有未保存的更改
        items.push(createFileItem);
      });

    return items;
  }, [mindMap.nodes, mindMap.edges, nodeCardsMapVersion, expandedNodes, pendingChanges, pendingRenames, pendingDragChanges, pendingDeletes, clipboard]);

  // 触发自动保存展开状态（带防抖）- 复用 mindmap_outline 的方式
  const triggerExpandAutoSave = useCallback(() => {
    // 清除之前的定时器（如果有）
    if (expandSaveTimerRef.current) {
      clearTimeout(expandSaveTimerRef.current);
      expandSaveTimerRef.current = null;
    }

    expandSaveTimerRef.current = setTimeout(async () => {
      try {
        // 使用 ref 获取最新的展开状态和节点数据
        const currentExpandedNodes = expandedNodesRef.current;
        const currentMindMap = mindMapRef.current;
        
        // 更新所有节点的 expanded 字段，匹配当前的展开状态
        const updatedNodes = currentMindMap.nodes.map((node) => {
          const isExpanded = currentExpandedNodes.has(node.id);
          return {
            ...node,
            expanded: isExpanded,
          };
        });

        // 调用 /save 接口保存整个 mindMap（包含 expanded 状态）
        // 过滤掉临时节点和边，确保不会保存临时数据
        const filteredNodes = updatedNodes.filter(n => !n.id.startsWith('temp-node-'));
        const filteredEdges = currentMindMap.edges.filter(e => 
          !e.source.startsWith('temp-node-') && 
          !e.target.startsWith('temp-node-') &&
          !e.id.startsWith('temp-edge-')
        );
        
        await request.post(getMindMapUrl('/save', docId), {
          nodes: filteredNodes,
          edges: filteredEdges,
          operationDescription: '自动保存展开状态',
        });
        
        // 更新本地 mindMap 状态（确保与后端同步）
        setMindMap(prev => ({
          ...prev,
          nodes: updatedNodes,
        }));
        
        expandSaveTimerRef.current = null;
      } catch (error: any) {
        console.error('保存展开状态失败:', error);
        expandSaveTimerRef.current = null;
      }
    }, 1500);
  }, [docId]);

  // 切换节点展开/折叠
  const toggleNodeExpanded = useCallback((nodeId: string) => {
    let newExpandedState: boolean;
    
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      const isExpanded = newSet.has(nodeId);
      newExpandedState = !isExpanded;
      
      if (isExpanded) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      
      // 立即更新 ref，确保自动保存时能获取最新值
      expandedNodesRef.current = newSet;
      
      // 立即更新本地 mindMap 状态，实现即时 UI 响应
      setMindMap(prev => {
        const updated = {
          ...prev,
          nodes: prev.nodes.map(n =>
            n.id === nodeId
              ? { ...n, expanded: newExpandedState }
              : n
          ),
        };
        // 立即更新 ref，确保自动保存时能获取最新值
        mindMapRef.current = updated;
        return updated;
      });
      
      return newSet;
    });
    
    // 触发自动保存（1.5秒后保存到后端）
    triggerExpandAutoSave();
  }, [triggerExpandAutoSave]);

  // 选择文件
  const handleSelectFile = useCallback(async (file: FileItem) => {
    // 如果是多选模式，切换选择状态
    if (isMultiSelectMode) {
      // 使用内联逻辑，避免循环依赖
      setSelectedItems(prev => {
        const next = new Set(prev);
        const isSelected = next.has(file.id);
        
        if (isSelected) {
          // 取消选择：移除当前项
          next.delete(file.id);
          
          // 如果是节点，同时取消选择所有子节点和卡片
          if (file.type === 'node' && getNodeChildrenRef.current) {
            const children = getNodeChildrenRef.current(file.nodeId || '');
            children.nodes.forEach(nodeId => {
              const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
              if (nodeFile) next.delete(nodeFile.id);
            });
            children.cards.forEach(cardId => {
              const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
              if (cardFile) next.delete(cardFile.id);
            });
          }
        } else {
          // 选择：添加当前项
          next.add(file.id);
          
          // 如果是节点，同时选择所有子节点和卡片
          if (file.type === 'node' && getNodeChildrenRef.current) {
            const children = getNodeChildrenRef.current(file.nodeId || '');
            children.nodes.forEach(nodeId => {
              const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
              if (nodeFile) next.add(nodeFile.id);
            });
            children.cards.forEach(cardId => {
              const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
              if (cardFile) next.add(cardFile.id);
            });
          }
        }
        
        return next;
      });
      return;
    }
    
    // 节点类型不显示编辑器，只支持重命名
    if (file.type === 'node') {
      return;
    }
    
    // 如果之前有选中的文件，保存其修改到待提交列表
    if (selectedFile && editorInstance) {
      try {
        const currentContent = editorInstance.value() || fileContent;
        const originalContent = originalContentsRef.current.get(selectedFile.id) || '';
        
        // 如果内容有变化，添加到待提交列表
        if (currentContent !== originalContent) {
          setPendingChanges(prev => {
            const newMap = new Map(prev);
            newMap.set(selectedFile.id, {
              file: selectedFile,
              content: currentContent,
              originalContent: originalContent,
            });
            return newMap;
          });
        }
      } catch (error) {
      }
    }
    
    setSelectedFile(file);
    selectedFileRef.current = file; // 更新ref，确保onChange回调能访问到最新的值
    
    // 先检查是否有待提交的修改
    const pendingChange = pendingChanges.get(file.id);
    let content = '';
    
    if (pendingChange) {
      // 如果有待提交的修改，使用修改后的内容
      content = pendingChange.content;
    } else {
      // 否则从原始数据加载（只处理 card 类型）
      if (file.type === 'card') {
        // 加载卡片内容
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[file.nodeId || ''] || [];
        const card = nodeCards.find((c: Card) => c.docId === file.cardId);
        content = card?.content || '';
      }
      
      // 保存原始内容（只在第一次加载时保存）
      if (!originalContentsRef.current.has(file.id)) {
        originalContentsRef.current.set(file.id, content);
      }
    }
    
    setFileContent(content);
  }, [mindMap.nodes, selectedFile, editorInstance, fileContent, pendingChanges, isMultiSelectMode, fileTree]);

  // 生成单选题
  const handleCreateSingleProblem = useCallback(async () => {
    if (!selectedFile || selectedFile.type !== 'card') {
      Notification.error('请先在左侧选择一个卡片');
      return;
    }

    const stem = problemStem.trim();
    const options = problemOptions.map(opt => opt.trim()).filter(opt => opt.length > 0);
    const analysis = problemAnalysis.trim();

    if (!stem) {
      Notification.error('题干不能为空');
      return;
    }
    if (options.length < 2) {
      Notification.error('至少需要两个选项');
      return;
    }
    if (problemAnswer < 0 || problemAnswer >= options.length) {
      Notification.error('请选择正确的答案选项');
      return;
    }

    try {
      setIsSavingProblem(true);

      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const nodeId = selectedFile.nodeId || '';
      const nodeCards: Card[] = nodeCardsMap[nodeId] || [];
      const card = nodeCards.find((c: Card) => c.docId === selectedFile.cardId);

      if (!card) {
        Notification.error('未找到对应的卡片数据，无法生成题目');
        return;
      }

      const existingProblems: CardProblem[] = card.problems || [];
      const newProblem: CardProblem = {
        pid: `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type: 'single',
        stem,
        options,
        answer: problemAnswer,
        analysis: analysis || undefined,
      };

      const updatedProblems = [...existingProblems, newProblem];

      // 只更新前端缓存，真正的保存由「保存更改」统一提交
      if (nodeCardsMap[nodeId]) {
        const cardIndex = nodeCards.findIndex((c: Card) => c.docId === selectedFile.cardId);
        if (cardIndex >= 0) {
          nodeCards[cardIndex] = {
            ...nodeCards[cardIndex],
            problems: updatedProblems,
          };
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);

          // 标记该卡片的题目有待提交（仅针对已有 cardId，临时卡片由创建时一起提交）
          if (!String(selectedFile.cardId || '').startsWith('temp-card-')) {
            setPendingProblemCardIds(prev => {
              const next = new Set(prev);
              next.add(String(selectedFile.cardId));
              return next;
            });
          }
        }
      }

      // 重置表单
      setProblemStem('');
      setProblemOptions(['', '', '', '']);
      setProblemAnswer(0);
      setProblemAnalysis('');

      Notification.success('单选题已生成并保存');
    } catch (error: any) {
      Notification.error('生成单选题失败: ' + (error.message || '未知错误'));
    } finally {
      setIsSavingProblem(false);
    }
  }, [selectedFile, problemStem, problemOptions, problemAnswer, problemAnalysis]);

  const handleSaveAll = useCallback(async () => {
    if (isCommitting) {
      return;
    }
    
    setIsCommitting(true);

    // 如果当前有选中的文件，先保存其修改
    let allChanges = new Map(pendingChanges);
    if (selectedFile && editorInstance) {
      try {
        const currentContent = editorInstance.value() || fileContent;
        const originalContent = originalContentsRef.current.get(selectedFile.id) || '';
        
        if (currentContent !== originalContent) {
          allChanges.set(selectedFile.id, {
            file: selectedFile,
            content: currentContent,
            originalContent: originalContent,
          });
        }
      } catch (error) {
      }
    }

    const hasContentChanges = allChanges.size > 0;
    const hasDragChanges = pendingDragChanges.size > 0;
    const hasRenameChanges = pendingRenames.size > 0;
    const hasCreateChanges = pendingCreatesRef.current.size > 0;
    const hasDeleteChanges = pendingDeletes.size > 0;
    const hasProblemChanges = pendingProblemCardIds.size > 0;
    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      const nodeIdMap = new Map<string, string>();
      let createCountBeforeSave = 0;
      
      if (hasCreateChanges) {
        const creates = Array.from(pendingCreatesRef.current.entries()).map(([tempId, create]) => ({ tempId, ...create })).filter(c => 
          c.tempId && (c.tempId.startsWith('temp-node-') || c.tempId.startsWith('temp-card-'))
        );
        createCountBeforeSave = creates.length;
        
        const successfullyCreated = new Set<string>();
        const processedFromSnapshot = new Set<string>();
        
        const nodeCreates = creates.filter(c => c.type === 'node');
        const nodeCreateMap = new Map<string, PendingCreate>();
        nodeCreates.forEach(c => {
          if (c.type === 'node') {
            nodeCreateMap.set(c.tempId, c);
          }
        });
        
        const processedNodeIds = new Set<string>();
        const processedInThisBatch = new Set<string>();
        let remainingNodes = nodeCreates.filter(c => c.type === 'node');
        while (remainingNodes.length > 0) {
          const beforeCount = remainingNodes.length;
          const currentRound: typeof remainingNodes = [];
          
          for (const create of remainingNodes) {
            if (create.type !== 'node') continue;
            
            if (processedInThisBatch.has(create.tempId)) {
              continue;
            }
            
            const parentId = create.nodeId;
            const isParentTemp = parentId && parentId.startsWith('temp-node-');
            
            if (isParentTemp) {
              if (!nodeIdMap.has(parentId)) {
                const parentCreate = nodeCreateMap.get(parentId);
                if (parentCreate) {
                  continue;
                } else {
                  continue;
                }
              }
            } else if (parentId) {
              const parentExists = mindMap.nodes.some(n => n.id === parentId);
              if (!parentExists) {
                continue;
              }
            }
            
            currentRound.push(create);
          }
          
          if (currentRound.length === 0) {
            break;
          }
          
          for (const create of currentRound) {
            if (processedFromSnapshot.has(create.tempId)) {
              processedNodeIds.add(create.tempId);
              continue;
            }
            
            if (processedInThisBatch.has(create.tempId)) {
              processedNodeIds.add(create.tempId);
              continue;
            }
            
            if (successfullyCreated.has(create.tempId)) {
              processedNodeIds.add(create.tempId);
              processedInThisBatch.add(create.tempId);
              processedFromSnapshot.add(create.tempId);
              continue;
            }
            
            if (!pendingCreatesRef.current.has(create.tempId)) {
              processedNodeIds.add(create.tempId);
              processedInThisBatch.add(create.tempId);
              processedFromSnapshot.add(create.tempId);
              continue;
            }
            
            if (processedInThisBatch.has(create.tempId) || processedFromSnapshot.has(create.tempId) || successfullyCreated.has(create.tempId)) {
              continue;
            }
            
            processedInThisBatch.add(create.tempId);
            processedFromSnapshot.add(create.tempId);
            
            try {
              // 如果父节点是临时节点，使用映射后的真实ID
              const realParentId = create.nodeId && create.nodeId.startsWith('temp-node-')
                ? nodeIdMap.get(create.nodeId)
                : create.nodeId;
              
              // 验证 realParentId 是否存在（如果是临时节点，必须已经映射）
              if (create.nodeId && create.nodeId.startsWith('temp-node-') && !realParentId) {
                continue;
              }
              
              if (successfullyCreated.has(create.tempId)) {
                continue;
              }
              
              const renameRecord = pendingRenames.get(create.tempId);
              const nodeText = renameRecord ? renameRecord.newName : (create.text || '新节点');
              
              const requestKey = `create-node-${create.tempId}`;
              if ((window as any).__pendingNodeCreationRequests?.has(requestKey)) {
                continue;
              }
              
              if (!(window as any).__pendingNodeCreationRequests) {
                (window as any).__pendingNodeCreationRequests = new Set<string>();
              }
              (window as any).__pendingNodeCreationRequests.add(requestKey);
              
              try {
                const response = await request.post(getMindMapUrl('/node', docId), {
                  operation: 'add',
                  text: nodeText,
                  parentId: realParentId,
                });
                
                (window as any).__pendingNodeCreationRequests.delete(requestKey);
              
                if (!response || !response.nodeId) {
                  continue;
                }
                
                const newNodeId = response.nodeId;
                const newEdgeId = response.edgeId;
                
                if (nodeIdMap.has(create.tempId)) {
                  continue;
                }
                
                if (successfullyCreated.has(create.tempId)) {
                  continue;
                }
                
                nodeIdMap.set(create.tempId, newNodeId);
                processedNodeIds.add(create.tempId);
                successfullyCreated.add(create.tempId);
                
                // 更新 mindMap，将临时 ID 替换为真实 ID
                setMindMap(prev => ({
                  ...prev,
                  nodes: prev.nodes.map(n => 
                    n.id === create.tempId 
                      ? { ...n, id: newNodeId, text: nodeText }
                      : n
                  ),
                  edges: prev.edges.map(e => 
                    e.target === create.tempId
                      ? { ...e, id: newEdgeId || e.id, target: newNodeId }
                      : e.source === create.tempId
                      ? { ...e, source: newNodeId }
                      : e
                  ),
                }));
                
                pendingCreatesRef.current.delete(create.tempId);
                setPendingCreatesCount(pendingCreatesRef.current.size);
                
                if (renameRecord) {
                  setPendingRenames(prev => {
                    const next = new Map(prev);
                    next.delete(create.tempId);
                    next.set(newNodeId, {
                      file: {
                        ...renameRecord.file,
                        id: newNodeId,
                        nodeId: newNodeId,
                      },
                      newName: renameRecord.newName,
                      originalName: renameRecord.originalName,
                    });
                    return next;
                  });
                }
              } catch (error: any) {
                const requestKey = `create-node-${create.tempId}`;
                if ((window as any).__pendingNodeCreationRequests) {
                  (window as any).__pendingNodeCreationRequests.delete(requestKey);
                }
                
                processedNodeIds.add(create.tempId);
                processedInThisBatch.add(create.tempId);
                
                setMindMap(prev => ({
                  ...prev,
                  nodes: prev.nodes.filter(n => n.id !== create.tempId),
                  edges: prev.edges.filter(e => e.target !== create.tempId && e.source !== create.tempId),
                }));
                pendingCreatesRef.current.delete(create.tempId);
                setPendingCreatesCount(pendingCreatesRef.current.size);
                // 如果有重命名记录，也移除
                setPendingRenames(prev => {
                  const next = new Map(prev);
                  next.delete(create.tempId);
                  return next;
                });
              }
            } catch (error: any) {
              processedNodeIds.add(create.tempId);
              processedInThisBatch.add(create.tempId);
            }
          }
          
          remainingNodes = remainingNodes.filter(c => {
            return !processedFromSnapshot.has(c.tempId) && !processedNodeIds.has(c.tempId) && !successfullyCreated.has(c.tempId);
          });
          
          if (remainingNodes.length === beforeCount) {
            break;
          }
        }
        
        for (const create of creates) {
          if (create.type === 'card') {
            if (!pendingCreatesRef.current.has(create.tempId)) {
              continue;
            }
            
            const createNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            let createNodeId = create.nodeId;
            
            if (!createNodeId) {
              continue;
            }
            
            // 如果节点ID是临时节点ID，尝试从nodeIdMap中获取真实ID
            if (createNodeId.startsWith('temp-node-')) {
              const realNodeId = nodeIdMap.get(createNodeId);
              if (realNodeId) {
                createNodeId = realNodeId;
              } else {
                // 临时节点还没有创建，跳过这个card，等待下一轮保存
                console.warn(`跳过创建card：临时节点 ${createNodeId} 还没有创建，等待下一轮保存`);
                continue;
              }
            }
            
            // 此时createNodeId应该是真实ID，不应该再是临时ID
            if (createNodeId.startsWith('temp-node-')) {
              console.warn(`跳过创建card：节点 ${createNodeId} 仍然是临时ID，无法创建card`);
              continue;
            }
            
            // 检查节点是否在待删除列表中
            if (pendingDeletes.has(createNodeId)) {
              console.warn(`跳过创建card：节点 ${createNodeId} 在待删除列表中`);
              // 清理这个待创建的card
              pendingCreatesRef.current.delete(create.tempId);
              setPendingCreatesCount(pendingCreatesRef.current.size);
              continue;
            }
            
            // 检查节点是否存在
            // 优先检查nodeIdMap（因为新创建的节点可能还没有更新到mindMap.nodes）
            const nodeExistsInMap = Array.from(nodeIdMap.values()).includes(createNodeId);
            const nodeExistsInMindMap = mindMap.nodes.some(n => n.id === createNodeId);
            
            if (!nodeExistsInMap && !nodeExistsInMindMap) {
              console.warn(`跳过创建card：节点 ${createNodeId} 不存在（不在nodeIdMap也不在mindMap.nodes中）`);
              // 清理这个待创建的card
              pendingCreatesRef.current.delete(create.tempId);
              setPendingCreatesCount(pendingCreatesRef.current.size);
              continue;
            }
            
            // 注意：createNodeCardsMap可能使用临时节点ID作为key，需要检查
            // 如果createNodeId是真实ID，但createNodeCardsMap中使用的是临时ID，需要查找
            let createNodeCards: Card[] = createNodeCardsMap[createNodeId] || [];
            // 如果找不到，尝试使用原始的临时节点ID查找
            if (createNodeCards.length === 0 && create.nodeId && create.nodeId.startsWith('temp-node-')) {
              createNodeCards = createNodeCardsMap[create.nodeId] || [];
            }
            const tempCard = createNodeCards.find((c: Card) => c.docId === create.tempId);

            // 检查 allChanges 中是否有对应的 content 更改（优先使用）
            const contentChange = allChanges.get(`card-${create.tempId}`);
            const finalContent = contentChange?.content ?? tempCard?.content ?? '';
            
            const cardRenameKey = `card-${create.tempId}`;
            const renameRecord = pendingRenames.get(cardRenameKey);
            const finalTitle = renameRecord ? renameRecord.newName : (create.title || tempCard?.title || '新卡片');
            const finalProblems = tempCard?.problems;

            const response = await request.post(getMindMapUrl('/card', docId), {
              nodeId: createNodeId,
              title: finalTitle,
              content: finalContent,
              problems: finalProblems,
            });
            
            const newCardId = response.cardId;

            // 为了保险，再用真实 cardId 做一次完整更新，确保标题和内容都写入
            if (newCardId) {
              try {
                await request.post(`/d/${domainId}/mindmap/card/${newCardId}`, {
                  operation: 'update',
                  nodeId: createNodeId,
                  title: finalTitle,
                  content: finalContent,
                  problems: finalProblems,
                });
              } catch (e) {
              }
            }
            
            // 更新 nodeCardsMap，将临时 ID 替换为真实 ID
            const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            // 需要找到正确的节点ID（可能是临时ID或真实ID）
            const originalNodeId = create.nodeId; // 原始的节点ID（可能是临时ID）
            const targetNodeId = createNodeId; // 真实的节点ID
            
            // 先尝试使用真实ID查找
            let cards = nodeCardsMap[targetNodeId];
            // 如果找不到，尝试使用原始临时ID查找
            if (!cards && originalNodeId && originalNodeId.startsWith('temp-node-')) {
              cards = nodeCardsMap[originalNodeId];
              // 如果找到了，需要将cards从临时ID的key移动到真实ID的key
              if (cards) {
                nodeCardsMap[targetNodeId] = cards;
                delete nodeCardsMap[originalNodeId];
              }
            }
            
            if (cards) {
              const tempCardIndex = cards.findIndex((c: Card) => c.docId === create.tempId);
              if (tempCardIndex >= 0) {
                cards[tempCardIndex] = {
                  ...cards[tempCardIndex],
                  docId: newCardId,
                  nodeId: targetNodeId, // 确保nodeId也是真实ID
                };
                (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              }
            }
            
            // 立即从 pendingCreatesRef 中移除已创建的卡片（避免重复创建）
            pendingCreatesRef.current.delete(create.tempId);
            setPendingCreatesCount(pendingCreatesRef.current.size);
            
            if (renameRecord) {
              setPendingRenames(prev => {
                const next = new Map(prev);
                next.delete(cardRenameKey);
                next.set(`card-${newCardId}`, {
                  file: {
                    ...renameRecord.file,
                    id: `card-${newCardId}`,
                    cardId: newCardId,
                  },
                  newName: renameRecord.newName,
                  originalName: renameRecord.originalName,
                });
                return next;
              });
            }
          }
        }
      }
      
      // 更新 allChanges 和 pendingRenames 中的临时节点ID为真实ID
      if (nodeIdMap.size > 0) {
        const changesToUpdate = new Map<string, PendingChange>();
        const changesToRemove: string[] = [];
        
        for (const [key, change] of allChanges.entries()) {
          if (change.file.type === 'node') {
            const keyIsTemp = key && key.startsWith('temp-node-');
            const fileIdIsTemp = change.file.id && change.file.id.startsWith('temp-node-');
            const nodeIdIsTemp = change.file.nodeId && change.file.nodeId.startsWith('temp-node-');
            
            if (keyIsTemp || fileIdIsTemp || nodeIdIsTemp) {
              const tempId = keyIsTemp ? key : 
                            (fileIdIsTemp ? change.file.id : change.file.nodeId);
              
              if (tempId && nodeIdMap.has(tempId)) {
                const realNodeId = nodeIdMap.get(tempId)!;
                const updatedChange: PendingChange = {
                  ...change,
                  file: {
                    ...change.file,
                    id: realNodeId,
                    nodeId: realNodeId,
                  },
                };
                changesToUpdate.set(realNodeId, updatedChange);
                changesToRemove.push(key);
              } else {
                changesToRemove.push(key);
              }
            }
          }
        }
        
        changesToRemove.forEach(key => {
          allChanges.delete(key);
        });
        changesToUpdate.forEach((change, newKey) => {
          allChanges.set(newKey, change);
        });
        
        // 更新 pendingRenames 中的临时节点ID
        setPendingRenames(prev => {
          const next = new Map(prev);
          const renamesToUpdate = new Map<string, PendingRename>();
          const renamesToRemove: string[] = [];
          
          for (const [key, rename] of next.entries()) {
            if (rename.file.type === 'node') {
              const nodeId = rename.file.nodeId || rename.file.id || key;
              if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
                const realNodeId = nodeIdMap.get(nodeId)!;
                renamesToUpdate.set(realNodeId, {
                  ...rename,
                  file: {
                    ...rename.file,
                    id: realNodeId,
                    nodeId: realNodeId,
                  },
                });
                renamesToRemove.push(key);
              } else if (nodeId && nodeId.startsWith('temp-node-')) {
                renamesToRemove.push(key);
              }
            }
          }
          
          renamesToRemove.forEach(key => next.delete(key));
          renamesToUpdate.forEach((rename, newKey) => next.set(newKey, rename));
          
          return next;
        });
      }
      
      // 保存内容更改（包括附带的题目）
      if (hasContentChanges) {
        // 先收集所有需要移除的临时节点 key
        const tempNodeKeysToRemove: string[] = [];
        for (const [key, change] of allChanges.entries()) {
          if (change.file.type === 'node') {
            const isTempNode = (key && key.startsWith('temp-node-')) ||
                              (change.file.id && change.file.id.startsWith('temp-node-')) ||
                              (change.file.nodeId && change.file.nodeId.startsWith('temp-node-'));
            if (isTempNode) {
              tempNodeKeysToRemove.push(key);
            }
          }
        }
        
        tempNodeKeysToRemove.forEach(key => {
          allChanges.delete(key);
        });
        
        const changes = Array.from(allChanges.values());
        
        // 批量保存所有内容更改
        for (const change of changes) {
          if (change.file.type === 'node') {
            const isTempNode = (change.file.id && change.file.id.startsWith('temp-node-')) ||
                              (change.file.nodeId && change.file.nodeId.startsWith('temp-node-'));
            if (isTempNode) {
              continue;
            }
            
            const nodeIdToUpdate = change.file.nodeId || change.file.id;
            if (!nodeIdToUpdate || nodeIdToUpdate.startsWith('temp-node-')) {
              continue;
            }
            
            // 保存节点文本（使用 /node/:nodeId 路径，与 mindmap_detail 保持一致）
            await request.post(getMindMapUrl(`/node/${nodeIdToUpdate}`, docId), {
              operation: 'update',
              text: change.content,
            });
            
            // 更新本地数据
            setMindMap(prev => ({
              ...prev,
              nodes: prev.nodes.map(n => 
                n.id === change.file.nodeId 
                  ? { ...n, text: change.content }
                  : n
              ),
            }));
          } else if (change.file.type === 'card') {
            const cardNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            const cardNodeId = change.file.nodeId || '';
            const cardNodeCards: Card[] = cardNodeCardsMap[cardNodeId] || [];
            const cardIndex = cardNodeCards.findIndex((c: Card) => c.docId === change.file.cardId);
            const card = cardIndex >= 0 ? cardNodeCards[cardIndex] : null;
            const problems = card?.problems;

            // 对于临时卡片：只更新前端 nodeCardsMap 中的 content，真正创建时再一次性写入后端
            if (!change.file.cardId || String(change.file.cardId).startsWith('temp-card-')) {
              if (cardIndex >= 0) {
                // 创建新数组，确保 React 能检测到变化
                const newCardNodeCards = [...cardNodeCards];
                newCardNodeCards[cardIndex] = { ...newCardNodeCards[cardIndex], content: change.content, problems };
                (window as any).UiContext.nodeCardsMap = { 
                  ...cardNodeCardsMap, 
                  [cardNodeId]: newCardNodeCards 
                };
              }
              continue;
            }

            // 对于已存在的卡片：保存卡片内容 + 本地练习题（使用全局 card 更新接口，不带 docId）
            await request.post(`/d/${domainId}/mindmap/card/${change.file.cardId}`, {
              operation: 'update',
              nodeId: change.file.nodeId,
              content: change.content,
              problems,
            });
            
            // 更新本地数据
            if (cardIndex >= 0) {
              cardNodeCards[cardIndex] = { ...cardNodeCards[cardIndex], content: change.content, problems };
              (window as any).UiContext.nodeCardsMap = { ...cardNodeCardsMap };
            }
          }
        }
      }

      // 仅题目发生变更但内容未变更的卡片：单独提交一次（不处理临时卡片）
      if (hasProblemChanges) {
        const nodeCardsMapForProblems = (window as any).UiContext?.nodeCardsMap || {};
        // 已经通过内容变更提交过的 cardId 集合
        const contentChangedCardIds = new Set<string>();
        for (const change of allChanges.values()) {
          if (change.file.type === 'card' && change.file.cardId) {
            contentChangedCardIds.add(String(change.file.cardId));
          }
        }

        for (const problemCardId of Array.from(pendingProblemCardIds)) {
          // 新建临时卡片的题目会在创建时一起提交，这里跳过 temp-card
          if (String(problemCardId).startsWith('temp-card-')) continue;
          // 如果已经在内容更新里提交过，就不用再提交一次
          if (contentChangedCardIds.has(String(problemCardId))) continue;

          // 在 nodeCardsMap 里找到这张卡片及其 nodeId 和 problems
          let foundNodeId: string | null = null;
          let foundCard: Card | null = null;
          for (const nodeId in nodeCardsMapForProblems) {
            const cards: Card[] = nodeCardsMapForProblems[nodeId] || [];
            const card = cards.find(c => c.docId === problemCardId);
            if (card) {
              foundNodeId = nodeId;
              foundCard = card;
              break;
            }
          }

          if (!foundNodeId || !foundCard) {
            continue;
          }

          // 仅更新题目，使用全局 card 更新接口
          await request.post(`/d/${domainId}/mindmap/card/${problemCardId}`, {
            operation: 'update',
            nodeId: foundNodeId,
            problems: foundCard.problems || [],
          });
        }
      }
      
      // 保存拖动更改（卡片的 nodeId 和 order，节点的 edges）
      if (hasDragChanges) {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        
        // 保存所有被拖动过的卡片
        for (const cardId of pendingDragChanges) {
          if (cardId.startsWith('node-')) {
            // 节点拖动，保存 edges
            const nodeId = cardId.replace('node-', '');
            
            // 从本地 mindMap.edges 中获取新的父节点连接
            const newEdges = mindMap.edges.filter(e => e.target === nodeId);
            const newEdge = newEdges.length > 0 ? newEdges[0] : null;
            
            if (newEdge) {
              try {
                // 获取数据库中该节点的所有 edges（作为 target 的边）
                const currentMindMap = await request.get(getMindMapUrl('/data', docId));
                const oldEdges = (currentMindMap.edges || []).filter(
                  (e: MindMapEdge) => e.target === nodeId
                );
                
                // 检查新边是否已存在（通过 source 和 target 匹配）
                const edgeExists = oldEdges.some(
                  (e: MindMapEdge) => e.source === newEdge.source && e.target === newEdge.target
                );
                
                // 删除所有旧的父节点连接（如果新边已存在，则不删除它）
                for (const oldEdge of oldEdges) {
                  // 检查是否是我们要保留的新边（通过 source 和 target 匹配）
                  const isNewEdge = oldEdge.source === newEdge.source && oldEdge.target === newEdge.target;
                  if (!isNewEdge && oldEdge.id) {
                    // 跳过临时 edge（前端生成的临时 ID）
                    if (oldEdge.id.startsWith('temp-') || oldEdge.id.startsWith('edge-')) {
                      continue;
                    }
                    
                    // 尝试删除旧的 edge，如果失败（edge 可能已经被删除），忽略错误
                    try {
                      await request.post(getMindMapUrl('/edge', docId), {
                        operation: 'delete',
                        edgeId: oldEdge.id,
                      });
                    } catch (deleteError: any) {
                      // Ignore delete errors
                    }
                  }
                }
                
                // 如果新边不存在，创建它
                if (!edgeExists) {
                  try {
                    await request.post(getMindMapUrl('/edge', docId), {
                      operation: 'add',
                      source: newEdge.source,
                      target: newEdge.target,
                    });
                  } catch (addError: any) {
                    // Ignore edge creation errors
                  }
                }
              } catch (error: any) {
                // If update fails, try to create edge directly
                try {
                  await request.post(getMindMapUrl('/edge', docId), {
                    operation: 'add',
                    source: newEdge.source,
                    target: newEdge.target,
                  });
                } catch (err: any) {
                  // Ignore edge creation errors
                }
              }
            }
          } else {
            // 卡片拖动，保存 nodeId 和 order
            // 在所有节点中查找这个卡片
            let foundCard: Card | null = null;
            let foundNodeId: string | null = null;
            
            for (const nodeId in nodeCardsMap) {
              const cards = nodeCardsMap[nodeId];
              const card = cards.find((c: Card) => c.docId === cardId);
              if (card) {
                foundCard = card;
                foundNodeId = nodeId; // 使用 nodeCardsMap 的 key 作为 nodeId
                break;
              }
            }
            
            if (foundCard && foundNodeId) {
              // 临时卡片（尚未真正创建），不调用后端更新接口，拖动顺序将在创建后再通过真实 ID 进行保存
              if (String(cardId).startsWith('temp-card-')) {
                continue;
              }
              // 使用找到的 nodeId（nodeCardsMap 的 key）和 card 的 order
              await request.post(`/d/${domainId}/mindmap/card/${cardId}`, {
                operation: 'update',
                nodeId: foundNodeId, // 使用 nodeCardsMap 的 key，确保是正确的 nodeId
                order: foundCard.order,
              });
              
              // 更新同一节点下所有受影响卡片的 order
              // 只更新那些在拖动操作中被修改了 order 的卡片，保持用户指定的位置
              const nodeCards = nodeCardsMap[foundNodeId] || [];
              
              // 保存所有卡片的 order（按当前 order 值保存，不重新计算）
              // 这样可以保持用户拖动时指定的位置
              for (const card of nodeCards) {
                // 跳过临时卡片
                if (String(card.docId).startsWith('temp-card-')) continue;
                if (card.order !== undefined && card.order !== null) {
                  // 只更新那些 order 确实需要保存的卡片
                  // 这里我们保存所有卡片的当前 order，因为它们可能都在拖动操作中被修改了
                  await request.post(`/d/${domainId}/mindmap/card/${card.docId}`, {
                    operation: 'update',
                    order: card.order,
                  });
                }
              }
            }
          }
        }
      }
      
      // 保存重命名更改
      if (hasRenameChanges) {
        // 使用更新后的 pendingRenames（如果节点创建后已更新）
        // 先获取最新的 pendingRenames 状态
        const renames = Array.from(pendingRenames.values());
        
        // 如果有 nodeIdMap，更新重命名记录中的临时ID为真实ID
        const updatedRenames = renames.map(rename => {
          if (rename.file.type === 'node') {
            const nodeId = rename.file.nodeId || rename.file.id;
            // 如果是临时节点，尝试从 nodeIdMap 中获取真实ID
            if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
              const realNodeId = nodeIdMap.get(nodeId)!;
              return {
                ...rename,
                file: {
                  ...rename.file,
                  id: realNodeId,
                  nodeId: realNodeId,
                },
              };
            }
          }
          return rename;
        });
        
        for (const rename of updatedRenames) {
          if (rename.file.type === 'node') {
            // 检查是否是临时节点
            const nodeId = rename.file.nodeId || rename.file.id;
            if (!nodeId || nodeId.startsWith('temp-node-')) {
              continue;
            }
            
            // 保存节点重命名
            // 与 mindmap_detail.page.tsx 保持一致，使用 operation: 'update'
            await request.post(getMindMapUrl(`/node/${nodeId}`, docId), {
              operation: 'update',
              text: rename.newName,
            });
          } else if (rename.file.type === 'card') {
            // 临时卡片的重命名只在前端保存，不调用后端
            if (!rename.file.cardId || String(rename.file.cardId).startsWith('temp-card-')) {
              continue;
            }
            // 保存卡片重命名
            await request.post(`/d/${domainId}/mindmap/card/${rename.file.cardId}`, {
              operation: 'update',
              title: rename.newName,
            });
          }
        }
      }

      const hasDeleteChanges = pendingDeletes.size > 0;
      
      // 保存删除操作
      if (hasDeleteChanges) {
        const deletes = Array.from(pendingDeletes.values());
        
        // 先删除所有card，再删除node（避免node删除时card已经被删除的情况）
        const cardDeletes = deletes.filter(d => d.type === 'card');
        const nodeDeletes = deletes.filter(d => d.type === 'node');
        
        // 删除所有card
        for (const del of cardDeletes) {
          // 临时卡片（尚未真正创建），只需要在前端移除，不调用后端删除接口
          if (!del.id || String(del.id).startsWith('temp-card-')) {
            continue;
          }
          
          // 删除已存在的卡片
          try {
            await request.post(`/d/${domainId}/mindmap/card/${del.id}`, {
              operation: 'delete',
            });
          } catch (deleteError: any) {
            // 如果card不存在（可能已经被删除），忽略错误继续处理
            const errorMessage = deleteError.message || deleteError.toString() || '';
            if (errorMessage.includes('Card not found') || errorMessage.includes('NotFoundError')) {
              console.warn(`Card ${del.id} not found, skipping deletion`);
              continue;
            }
            // 其他错误继续抛出
            throw deleteError;
          }
        }
        
        // 删除所有node
        for (const del of nodeDeletes) {
          // 临时节点（尚未真正创建），只需要在前端移除，不调用后端删除接口
          if (!del.id || String(del.id).startsWith('temp-node-')) {
            continue;
          }
          
          // 删除节点（需要先删除所有相关的 edges）
          // 从后端获取最新的 edges，因为前端可能已经删除了这些 edges
          try {
            const currentMindMap = await request.get(getMindMapUrl('/data', docId));
            const nodeEdges = (currentMindMap.edges || []).filter(
              (e: MindMapEdge) => e.source === del.id || e.target === del.id
            );
            
            for (const edge of nodeEdges) {
              try {
                await request.post(getMindMapUrl('/edge', docId), {
                  operation: 'delete',
                  edgeId: edge.id,
                });
              } catch (deleteError: any) {
                // 如果删除失败，可能是 edge 已经被删除，继续处理
                console.warn('Failed to delete edge:', edge.id, deleteError);
              }
            }
          } catch (error: any) {
            // 如果获取数据失败，尝试直接从 mindMap 中查找（向后兼容）
            const nodeEdges = mindMap.edges.filter(
              e => e.source === del.id || e.target === del.id
            );
            
            for (const edge of nodeEdges) {
              try {
                await request.post(getMindMapUrl('/edge', docId), {
                  operation: 'delete',
                  edgeId: edge.id,
                });
              } catch (deleteError: any) {
                // 如果删除失败，可能是 edge 已经被删除，继续处理
                console.warn('Failed to delete edge:', edge.id, deleteError);
              }
            }
          }
          
          // 删除节点
          await request.post(getMindMapUrl(`/node/${del.id}`, docId), {
            operation: 'delete',
          });
        }
      }

      // 计算总更改数（使用保存前的值，因为创建过程中pendingCreates已经被清空）
      // 注意：如果节点创建时使用了重命名后的文本，不应该重复计算重命名
      // 检查是否有重命名记录对应已创建的节点，如果有，不应该重复计算
      let actualRenameCount = 0;
      if (hasRenameChanges && nodeIdMap.size > 0) {
        // 对于已创建的节点，如果重命名记录中的节点ID是临时ID，说明重命名已经在创建时处理了，不应该重复计算
        const renames = Array.from(pendingRenames.values());
        actualRenameCount = renames.filter(rename => {
          if (rename.file.type === 'node') {
            const nodeId = rename.file.nodeId || rename.file.id;
            // 如果节点ID是临时ID且在nodeIdMap中，说明重命名已经在创建时处理了
            if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
              return false; // 不计算这个重命名
            }
          }
          return true; // 计算其他重命名
        }).length;
      } else {
        actualRenameCount = hasRenameChanges ? pendingRenames.size : 0;
      }
      
      const totalChanges = (hasContentChanges ? allChanges.size : 0) 
        + (hasDragChanges ? pendingDragChanges.size : 0) 
        + actualRenameCount
        + createCountBeforeSave
        + (hasDeleteChanges ? pendingDeletes.size : 0);
      
      console.log('Total changes calculation:', {
        hasContentChanges,
        contentChanges: hasContentChanges ? allChanges.size : 0,
        hasDragChanges,
        dragChanges: hasDragChanges ? pendingDragChanges.size : 0,
        hasRenameChanges,
        renameChanges: actualRenameCount,
        createCount: createCountBeforeSave,
        hasDeleteChanges,
        deleteChanges: hasDeleteChanges ? pendingDeletes.size : 0,
        total: totalChanges,
      });
      
      Notification.success(`已保存 ${totalChanges} 个更改`);
      
      // 如果有创建或重命名更改，重新加载数据以确保同步
      if (hasCreateChanges || hasRenameChanges) {
        try {
          // 在重新加载前，先清理 mindMap 中的临时节点，避免重复创建
          setMindMap(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !n.id.startsWith('temp-node-')),
            edges: prev.edges.filter(e => 
              !e.source.startsWith('temp-node-') && 
              !e.target.startsWith('temp-node-') &&
              !e.id.startsWith('temp-edge-')
            ),
          }));
          
          const response = await request.get(getMindMapUrl('/data', docId));
          setMindMap(response);
          // 更新 nodeCardsMap（如果有卡片重命名）
          const renames = Array.from(pendingRenames.values());
          for (const rename of renames) {
            if (rename.file.type === 'card') {
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              if (nodeCardsMap[rename.file.nodeId || '']) {
                const cards = nodeCardsMap[rename.file.nodeId || ''];
                const cardIndex = cards.findIndex((c: Card) => c.docId === rename.file.cardId);
                if (cardIndex >= 0) {
                  cards[cardIndex] = { ...cards[cardIndex], title: rename.newName };
                  (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
                  setNodeCardsMapVersion(prev => prev + 1);
                }
              }
            }
          }
          console.log('Reloaded mindmap data after save, nodes count:', response.nodes.length);
        } catch (error) {
          console.warn('Failed to reload mindmap data after save:', error);
        }
      }
      
      // 清空待提交列表
      setPendingChanges(new Map());
      setPendingDragChanges(new Set());
      setPendingRenames(new Map());
      pendingCreatesRef.current.clear();
      setPendingCreatesCount(0);
      setPendingDeletes(new Map());
      setPendingProblemCardIds(new Set());
      
      // 更新原始内容引用
      if (hasContentChanges) {
        const changes = Array.from(allChanges.values());
        changes.forEach(change => {
          originalContentsRef.current.set(change.file.id, change.content);
        });
      }
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
    } finally {
      setIsCommitting(false);
    }
  }, [pendingChanges, pendingDragChanges, pendingRenames, pendingDeletes, selectedFile, editorInstance, fileContent, docId, getMindMapUrl, mindMap.edges]);

  // 重命名文件（仅前端修改，保存时才提交到后端）
  const handleRename = useCallback((file: FileItem, newName: string) => {
    if (!newName.trim()) {
      Notification.error('名称不能为空');
      return;
    }

    const trimmedName = newName.trim();
    
    // 如果名称没有变化，移除待重命名记录
    if (trimmedName === file.name) {
      setPendingRenames(prev => {
        const next = new Map(prev);
        next.delete(file.id);
        return next;
      });
      setEditingFile(null);
      return;
    }
    
    // 更新本地数据（立即显示）
    if (file.type === 'node') {
      // 更新节点名称
      setMindMap(prev => ({
        ...prev,
        nodes: prev.nodes.map(n => 
          n.id === file.nodeId 
            ? { ...n, text: trimmedName }
            : n
        ),
      }));
    } else if (file.type === 'card') {
      // 更新卡片名称
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === file.cardId);
        if (cardIndex >= 0) {
          cards[cardIndex] = { ...cards[cardIndex], title: trimmedName };
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          // 触发 fileTree 重新计算
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    // 添加到待重命名列表
    setPendingRenames(prev => {
      const next = new Map(prev);
      next.set(file.id, {
        file,
        newName: trimmedName,
        originalName: file.name,
      });
      return next;
    });
    
    setEditingFile(null);
  }, []);

  // 开始重命名
  const handleStartRename = useCallback((file: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingFile(file);
    setEditingName(file.name);
  }, []);

  // 取消重命名
  const handleCancelRename = useCallback(() => {
    setEditingFile(null);
    setEditingName('');
  }, []);

  // 确认重命名
  const handleConfirmRename = useCallback(async () => {
    if (editingFile) {
      await handleRename(editingFile, editingName);
    }
  }, [editingFile, editingName, handleRename]);

  // 新建卡片（前端操作）
  const handleNewCard = useCallback((nodeId: string) => {
    // 检查节点是否在待删除列表中
    if (pendingDeletes.has(nodeId)) {
      Notification.error('无法创建：该节点已在待删除列表中');
      setContextMenu(null);
      return;
    }
    
    // 检查节点是否存在
    const nodeExists = mindMap.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error('无法创建：节点不存在');
      setContextMenu(null);
      return;
    }
    
    const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newCard: PendingCreate = {
      type: 'card',
      nodeId,
      title: '新卡片',
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newCard);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    // 更新 nodeCardsMap（前端显示）
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (!nodeCardsMap[nodeId]) {
      nodeCardsMap[nodeId] = [];
    }
    const maxOrder = nodeCardsMap[nodeId].length > 0 
      ? Math.max(...nodeCardsMap[nodeId].map((c: Card) => c.order || 0))
      : 0;
    
    const tempCard: Card = {
      docId: tempId,
      cid: 0,
      nodeId,
      title: '新卡片',
      content: '',
      order: maxOrder + 1,
      updateAt: new Date().toISOString(),
    } as Card;
    
    nodeCardsMap[nodeId].push(tempCard);
    nodeCardsMap[nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion(prev => prev + 1);
    
    setContextMenu(null);
  }, [pendingDeletes, mindMap.nodes]);

  // 新建子节点（前端操作）
  const handleNewChildNode = useCallback((parentNodeId: string) => {
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newChildNode: PendingCreate = {
      type: 'node',
      nodeId: parentNodeId,
      text: '新节点',
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newChildNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    // 更新 mindMap（前端显示）
    const tempNode: MindMapNode = {
      id: tempId,
      text: '新节点',
    };
    
    setMindMap(prev => ({
      ...prev,
      nodes: [...prev.nodes, tempNode],
      edges: [...prev.edges, {
        id: `temp-edge-${Date.now()}`,
        source: parentNodeId,
        target: tempId,
      }],
    }));
    
    // 展开父节点以便看到新节点
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (!newSet.has(parentNodeId)) {
        newSet.add(parentNodeId);
        // 立即更新 ref，确保自动保存时能获取最新值
        expandedNodesRef.current = newSet;
        // 立即更新本地 mindMap 状态
        setMindMap(prev => {
          const updated = {
            ...prev,
            nodes: prev.nodes.map(n =>
              n.id === parentNodeId
                ? { ...n, expanded: true }
                : n
            ),
          };
          // 立即更新 ref，确保自动保存时能获取最新值
          mindMapRef.current = updated;
          return updated;
        });
        // 触发自动保存
        triggerExpandAutoSave();
      }
      return newSet;
    });
    
    setContextMenu(null);
  }, [triggerExpandAutoSave]);

  // 复制节点或卡片（支持多选）
  const handleCopy = useCallback((file?: FileItem) => {
    let itemsToCopy: FileItem[] = [];
    
    // 如果有多选且传入了file，使用多选；否则使用单个file
    if (isMultiSelectMode && selectedItems.size > 0 && !file) {
      // 多选模式：复制所有选中的项目
      itemsToCopy = fileTree.filter(f => selectedItems.has(f.id));
    } else if (file) {
      // 单个文件模式
      itemsToCopy = [file];
    } else {
      return;
    }
    
    if (itemsToCopy.length === 0) return;
    
    setClipboard({ type: 'copy', items: itemsToCopy });
    
    // 同时将信息存储到系统剪贴板，以便在 AI 对话框中粘贴时识别
    if (navigator.clipboard && navigator.clipboard.writeText && itemsToCopy.length === 1) {
      const firstItem = itemsToCopy[0];
      const reference = firstItem.type === 'node' 
        ? `ejunz://node/${firstItem.nodeId}`
        : `ejunz://card/${firstItem.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        // 如果写入失败，忽略错误（可能是权限问题）
      });
    }
    
    setContextMenu(null);
  }, [isMultiSelectMode, selectedItems, fileTree]);

  // 剪切节点或卡片（支持多选）
  const handleCut = useCallback((file?: FileItem) => {
    let itemsToCut: FileItem[] = [];
    
    // 如果有多选且传入了file，使用多选；否则使用单个file
    if (isMultiSelectMode && selectedItems.size > 0 && !file) {
      // 多选模式：剪切所有选中的项目
      itemsToCut = fileTree.filter(f => selectedItems.has(f.id));
    } else if (file) {
      // 单个文件模式
      itemsToCut = [file];
    } else {
      return;
    }
    
    if (itemsToCut.length === 0) return;
    
    setClipboard({ type: 'cut', items: itemsToCut });
    
    // 同时将信息存储到系统剪贴板，以便在 AI 对话框中粘贴时识别
    if (navigator.clipboard && navigator.clipboard.writeText && itemsToCut.length === 1) {
      const firstItem = itemsToCut[0];
      const reference = firstItem.type === 'node' 
        ? `ejunz://node/${firstItem.nodeId}`
        : `ejunz://card/${firstItem.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        // 如果写入失败，忽略错误（可能是权限问题）
      });
    }
    
    setContextMenu(null);
  }, [isMultiSelectMode, selectedItems, fileTree]);

  // 清理临时card/node的所有pending操作
  const cleanupPendingForTempItem = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      const nodeId = file.nodeId || '';
      if (nodeId.startsWith('temp-node-')) {
        // 从 pendingCreatesRef 中移除
        pendingCreatesRef.current.delete(nodeId);
        setPendingCreatesCount(pendingCreatesRef.current.size);
        
        // 从 pendingChanges 中移除
        setPendingChanges(prev => {
          const next = new Map(prev);
          next.delete(nodeId);
          return next;
        });
        
        // 从 pendingRenames 中移除
        setPendingRenames(prev => {
          const next = new Map(prev);
          next.delete(nodeId);
          return next;
        });
        
        // 从 pendingDragChanges 中移除
        setPendingDragChanges(prev => {
          const next = new Set(prev);
          next.delete(`node-${nodeId}`);
          return next;
        });
        
        // 清理该node下的所有临时card的pending操作
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const nodeCards = nodeCardsMap[nodeId] || [];
        for (const card of nodeCards) {
          const cardId = card.docId;
          if (cardId && cardId.startsWith('temp-card-')) {
            // 从 pendingCreatesRef 中移除
            pendingCreatesRef.current.delete(cardId);
            setPendingCreatesCount(pendingCreatesRef.current.size);
            
            // 从 pendingChanges 中移除（card的id是 card-${cardId}）
            setPendingChanges(prev => {
              const next = new Map(prev);
              next.delete(`card-${cardId}`);
              return next;
            });
            
            // 从 pendingRenames 中移除
            setPendingRenames(prev => {
              const next = new Map(prev);
              next.delete(`card-${cardId}`);
              return next;
            });
            
            // 从 pendingDragChanges 中移除
            setPendingDragChanges(prev => {
              const next = new Set(prev);
              next.delete(cardId);
              return next;
            });
          }
        }
      }
    } else if (file.type === 'card') {
      const cardId = file.cardId || '';
      if (cardId.startsWith('temp-card-')) {
        // 从 pendingCreatesRef 中移除
        pendingCreatesRef.current.delete(cardId);
        setPendingCreatesCount(pendingCreatesRef.current.size);
        
        // 从 pendingChanges 中移除（card的id是 card-${cardId}）
        setPendingChanges(prev => {
          const next = new Map(prev);
          next.delete(`card-${cardId}`);
          return next;
        });
        
        // 从 pendingRenames 中移除
        setPendingRenames(prev => {
          const next = new Map(prev);
          next.delete(`card-${cardId}`);
          return next;
        });
        
        // 从 pendingDragChanges 中移除
        setPendingDragChanges(prev => {
          const next = new Set(prev);
          next.delete(cardId);
          return next;
        });
      }
    }
  }, []);

  // 粘贴节点或卡片（支持多个项目）
  const handlePaste = useCallback((targetNodeId: string) => {
    if (!clipboard || clipboard.items.length === 0) return;

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};

    // 遍历所有要粘贴的项目
    for (const item of clipboard.items) {
      if (item.type === 'node') {
        const sourceNodeId = item.nodeId || '';
        const sourceNode = mindMap.nodes.find(n => n.id === sourceNodeId);
        
        // 如果源节点不存在，可能是已经被删除或移动了
        if (!sourceNode) {
          // 如果是剪切操作，清空剪贴板
          if (clipboard.type === 'cut') {
            setClipboard(null);
          }
          continue; // 跳过这个项目，继续处理下一个
        }
      
      // 如果剪切的是临时节点（已经粘贴过的），需要先清理所有相关的pending操作
      if (clipboard.type === 'cut' && sourceNodeId.startsWith('temp-node-')) {
        // 使用cleanupPendingForTempItem清理所有pending操作
        cleanupPendingForTempItem({ type: 'node', id: sourceNodeId, nodeId: sourceNodeId, name: sourceNode.text || '', level: 0 });
      }

      // 收集所有需要复制的节点（包括子节点）
      const nodesToCopy: MindMapNode[] = [];
      const nodeIdMap = new Map<string, string>(); // 旧ID -> 新ID映射
      let nodeCounter = 0;

      // 递归收集节点
      const collectNodes = (nodeId: string) => {
        const node = mindMap.nodes.find(n => n.id === nodeId);
        if (!node) return;

        // 如果已经收集过，跳过
        if (nodeIdMap.has(nodeId)) return;

        nodeCounter++;
        const newId = `temp-node-${Date.now()}-${nodeCounter}-${Math.random().toString(36).substr(2, 9)}`;
        nodeIdMap.set(nodeId, newId);

        const newNode: MindMapNode = {
          ...node,
          id: newId,
          text: node.text,
        };
        nodesToCopy.push(newNode);

        // 递归收集子节点
        const childEdges = mindMap.edges.filter(e => e.source === nodeId);
        childEdges.forEach(edge => {
          collectNodes(edge.target);
        });
      };

      collectNodes(sourceNodeId);

      // 构建新的 edges（在收集完所有节点后）
      const updatedEdges: MindMapEdge[] = [];
      
      // 复制所有相关的 edges
      mindMap.edges.forEach(edge => {
        const newSource = nodeIdMap.get(edge.source);
        const newTarget = nodeIdMap.get(edge.target);
        if (newSource && newTarget) {
          updatedEdges.push({
            id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            source: newSource,
            target: newTarget,
          });
        }
      });

      // 添加根节点到目标节点的边
      const rootNewId = nodeIdMap.get(sourceNodeId);
      if (rootNewId) {
        updatedEdges.push({
          id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          source: targetNodeId,
          target: rootNewId,
        });
      }

      // 更新 mindMap
      // 检查是否已存在（避免重复）
      setMindMap(prev => {
        const existingNodeIds = new Set(prev.nodes.map(n => n.id));
        const newNodes = nodesToCopy.filter(n => !existingNodeIds.has(n.id));
        const existingEdgeKeys = new Set(prev.edges.map(e => `${e.source}-${e.target}`));
        const newEdges = updatedEdges.filter(e => !existingEdgeKeys.has(`${e.source}-${e.target}`));
        return {
          ...prev,
          nodes: [...prev.nodes, ...newNodes],
          edges: [...prev.edges, ...newEdges],
        };
      });

      // 复制卡片
      nodesToCopy.forEach(newNode => {
        const oldNodeId = Array.from(nodeIdMap.entries()).find(([_, newId]) => newId === newNode.id)?.[0];
        if (oldNodeId && nodeCardsMap[oldNodeId]) {
          const cards = nodeCardsMap[oldNodeId];
          const newCards = cards.map((card: Card, index: number) => {
            const newCardId = `temp-card-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`;
            return {
              ...card,
              docId: newCardId,
              nodeId: newNode.id,
            };
          });

          if (!nodeCardsMap[newNode.id]) {
            nodeCardsMap[newNode.id] = [];
          }
          nodeCardsMap[newNode.id].push(...newCards);
          
          // 将复制的卡片添加到待创建列表
          newCards.forEach(newCard => {
            if (!pendingCreatesRef.current.has(newCard.docId)) {
              pendingCreatesRef.current.set(newCard.docId, {
                type: 'card',
                nodeId: newNode.id,
                title: newCard.title || '新卡片',
                tempId: newCard.docId,
              });
              setPendingCreatesCount(pendingCreatesRef.current.size);
            }
          });
        }
      });
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };

      // 如果是剪切，删除原节点
      if (clipboard.type === 'cut') {
        // 如果源节点是临时节点（已经粘贴过的），不需要添加到 pendingDeletes
        // 只需要从 mindMap 中删除即可
        if (sourceNodeId.startsWith('temp-node-')) {
          // 临时节点，直接删除，不需要标记为待删除
          // 清理所有相关的卡片（包括它们的pending操作）
          nodeIdMap.forEach((newId, oldId) => {
            // 清理该节点下所有临时card的pending操作
            const oldCards = nodeCardsMap[oldId] || [];
            oldCards.forEach((card: Card) => {
              if (card.docId && card.docId.startsWith('temp-card-')) {
                cleanupPendingForTempItem({ 
                  type: 'card', 
                  id: `card-${card.docId}`, 
                  cardId: card.docId, 
                  nodeId: oldId, 
                  name: card.title || '', 
                  level: 0 
                });
              }
            });
            // 删除节点下的卡片
            if (nodeCardsMap[oldId]) {
              delete nodeCardsMap[oldId];
            }
          });
          
          setMindMap(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
          
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        } else {
          // 真实节点，需要标记为待删除
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(sourceNodeId, {
              type: 'node',
              id: sourceNodeId,
            });
            return next;
          });

          setMindMap(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
        }
      }

      // 添加到待创建列表
      nodesToCopy.forEach(newNode => {
        const oldNodeId = Array.from(nodeIdMap.entries()).find(([_, newId]) => newId === newNode.id)?.[0];
        if (oldNodeId) {
          // 检查是否已存在（避免重复）
          if (!pendingCreatesRef.current.has(newNode.id)) {
            pendingCreatesRef.current.set(newNode.id, {
              type: 'node',
              nodeId: targetNodeId,
              text: newNode.text || '新节点',
              tempId: newNode.id,
            });
            setPendingCreatesCount(pendingCreatesRef.current.size);
          }
        }
      });

      setNodeCardsMapVersion(prev => prev + 1);
      setExpandedNodes(prev => {
        const newSet = new Set(prev);
        if (!newSet.has(targetNodeId)) {
          newSet.add(targetNodeId);
          // 立即更新 ref，确保自动保存时能获取最新值
          expandedNodesRef.current = newSet;
          // 立即更新本地 mindMap 状态
          setMindMap(prev => {
            const updated = {
              ...prev,
              nodes: prev.nodes.map(n =>
                n.id === targetNodeId
                  ? { ...n, expanded: true }
                  : n
              ),
            };
            // 立即更新 ref，确保自动保存时能获取最新值
            mindMapRef.current = updated;
            return updated;
          });
          // 触发自动保存
          triggerExpandAutoSave();
        }
        return newSet;
      });

      } else if (item.type === 'card') {
        const sourceCardId = item.cardId || '';
        const sourceNodeId = item.nodeId || '';

        // 找到源卡片
        const sourceCards = nodeCardsMap[sourceNodeId] || [];
        const sourceCard = sourceCards.find((c: Card) => c.docId === sourceCardId);
        
        // 如果源卡片不存在，可能是已经被删除或移动了
        if (!sourceCard) {
          // 如果是剪切操作，清空剪贴板
          if (clipboard.type === 'cut') {
            setClipboard(null);
          }
          continue; // 跳过这个项目，继续处理下一个
        }
      
      // 如果剪切的是临时卡片（已经粘贴过的），需要先清理所有相关的pending操作
      if (clipboard.type === 'cut' && sourceCardId.startsWith('temp-card-')) {
        // 使用cleanupPendingForTempItem清理所有pending操作
        cleanupPendingForTempItem({ 
          type: 'card', 
          id: `card-${sourceCardId}`, 
          cardId: sourceCardId, 
          nodeId: sourceNodeId, 
          name: sourceCard.title || '', 
          level: 0 
        });
      }

      const newCardId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const maxOrder = nodeCardsMap[targetNodeId]?.length > 0
        ? Math.max(...nodeCardsMap[targetNodeId].map((c: Card) => c.order || 0))
        : 0;

      const newCard: Card = {
        ...sourceCard,
        docId: newCardId,
        nodeId: targetNodeId,
        order: maxOrder + 1,
      };

      // 更新 nodeCardsMap
      if (!nodeCardsMap[targetNodeId]) {
        nodeCardsMap[targetNodeId] = [];
      }
      // 检查是否已存在（避免重复）
      const existingIndex = nodeCardsMap[targetNodeId].findIndex((c: Card) => c.docId === newCardId);
      if (existingIndex === -1) {
        nodeCardsMap[targetNodeId].push(newCard);
        nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      }

      // 如果是剪切，从原节点移除
      if (clipboard.type === 'cut') {
        const sourceCards = nodeCardsMap[sourceNodeId] || [];
        const cardIndex = sourceCards.findIndex((c: Card) => c.docId === sourceCardId);
        if (cardIndex >= 0) {
          sourceCards.splice(cardIndex, 1);
          nodeCardsMap[sourceNodeId] = sourceCards;
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);

          // 如果源卡片是临时卡片（已经粘贴过的），不需要添加到 pendingDeletes
          // 已经在前面清理过了
          if (!sourceCardId.startsWith('temp-card-')) {
            // 真实卡片，需要标记为待删除
            setPendingDeletes(prev => {
              const next = new Map(prev);
              next.set(sourceCardId, {
                type: 'card',
                id: sourceCardId,
                nodeId: sourceNodeId,
              });
              return next;
            });
          }
        }
      }

      // 添加到待创建列表（用于保存时创建）
      // 检查是否已存在（避免重复）
      if (!pendingCreatesRef.current.has(newCardId)) {
        pendingCreatesRef.current.set(newCardId, {
          type: 'card',
          nodeId: targetNodeId,
          title: newCard.title || '新卡片',
          tempId: newCardId,
        });
        setPendingCreatesCount(pendingCreatesRef.current.size);
      }

        setNodeCardsMapVersion(prev => prev + 1);
      }
    }

    // 如果是剪切，清空剪贴板；如果是复制，保留
    if (clipboard.type === 'cut') {
      setClipboard(null);
    }

    setContextMenu(null);
  }, [clipboard, mindMap, setMindMap, cleanupPendingForTempItem, triggerExpandAutoSave]);

  // 处理拖拽调整大小
  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const deltaX = resizeStartXRef.current - e.clientX; // 向左拖拽时 deltaX 为正
      const newWidth = Math.max(200, Math.min(800, resizeStartWidthRef.current + deltaX));
      setChatPanelWidth(newWidth);
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
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

  // 自动滚动聊天消息到底部
  useEffect(() => {
    if (chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // 获取节点的完整路径（从根节点到当前节点）
  const getNodePath = useCallback((nodeId: string): string[] => {
    const path: string[] = [];
    const nodeMap = new Map<string, string>(); // parentId -> nodeId
    
    // 构建父子关系映射
    mindMap.edges.forEach((edge) => {
      nodeMap.set(edge.target, edge.source);
    });
    
    // 从当前节点向上追溯到根节点
    let currentNodeId: string | undefined = nodeId;
    while (currentNodeId) {
      const node = mindMap.nodes.find(n => n.id === currentNodeId);
      if (node) {
        path.unshift(node.text || '未命名节点');
      }
      currentNodeId = nodeMap.get(currentNodeId);
    }
    
    return path;
  }, [mindMap]);

  // 处理 AI 对话框中的粘贴事件，自动识别复制的 node/card
  const handleAIChatPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const textarea = e.currentTarget;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const currentText = chatInput;

    let reference: { type: 'node' | 'card'; id: string; name: string; path: string[] } | null = null;
    let shouldPreventDefault = false;

    // 首先检查内部 clipboard state
    if (clipboard && clipboard.type === 'copy' && clipboard.items.length > 0) {
      // 只使用第一个项目来生成引用（用于AI对话框）
      const firstItem = clipboard.items[0];
      if (firstItem.type === 'node') {
        const nodeId = firstItem.nodeId || '';
        const node = mindMap.nodes.find(n => n.id === nodeId);
        if (node) {
          const path = getNodePath(nodeId);
          reference = {
            type: 'node',
            id: nodeId,
            name: node.text || '未命名节点',
            path,
          };
          shouldPreventDefault = true;
        }
      } else if (firstItem.type === 'card') {
        const cardId = firstItem.cardId || '';
        const nodeId = firstItem.nodeId || '';
        const cards = nodeCardsMap[nodeId] || [];
        const card = cards.find((c: Card) => c.docId === cardId);
        if (card) {
          const nodePath = getNodePath(nodeId);
          const cardPath = [...nodePath, card.title || '未命名卡片'];
          reference = {
            type: 'card',
            id: cardId,
            name: card.title || '未命名卡片',
            path: cardPath,
          };
          shouldPreventDefault = true;
        }
      }
    }

    // 如果没有从内部 clipboard 找到，尝试从系统剪贴板读取
    if (!reference) {
      try {
        const clipboardText = e.clipboardData.getData('text');
        if (clipboardText) {
          // 检查是否是我们的自定义格式
          const nodeMatch = clipboardText.match(/^ejunz:\/\/node\/(.+)$/);
          const cardMatch = clipboardText.match(/^ejunz:\/\/card\/(.+)$/);
          
          if (nodeMatch) {
            const nodeId = nodeMatch[1];
            const node = mindMap.nodes.find(n => n.id === nodeId);
            if (node) {
              const path = getNodePath(nodeId);
              reference = {
                type: 'node',
                id: nodeId,
                name: node.text || '未命名节点',
                path,
              };
              shouldPreventDefault = true;
            }
          } else if (cardMatch) {
            const cardId = cardMatch[1];
            // 需要遍历所有节点找到对应的卡片
            for (const nodeId in nodeCardsMap) {
              const cards = nodeCardsMap[nodeId] || [];
              const card = cards.find((c: Card) => c.docId === cardId);
              if (card) {
                const nodePath = getNodePath(nodeId);
                const cardPath = [...nodePath, card.title || '未命名卡片'];
                reference = {
                  type: 'card',
                  id: cardId,
                  name: card.title || '未命名卡片',
                  path: cardPath,
                };
                shouldPreventDefault = true;
                break;
              }
            }
          }
        }
      } catch (err) {
        // 如果读取剪贴板失败，忽略错误
        console.warn('Failed to read clipboard:', err);
      }
    }

    if (reference && shouldPreventDefault) {
      e.preventDefault();
      // 在光标位置插入占位符文本（用于计算位置）
      const placeholder = `@${reference.name}`;
      const newText = 
        currentText.slice(0, selectionStart) + 
        placeholder + 
        currentText.slice(selectionEnd);
      
      // 更新引用列表
      setChatInputReferences(prev => {
        const newRefs = prev.map(ref => {
          // 调整后续引用的位置
          if (ref.startIndex >= selectionStart) {
            return {
              ...ref,
              startIndex: ref.startIndex + placeholder.length,
              endIndex: ref.endIndex + placeholder.length,
            };
          }
          return ref;
        });
        
        // 添加新引用
        newRefs.push({
          type: reference!.type,
          id: reference!.id,
          name: reference!.name,
          path: reference!.path,
          startIndex: selectionStart,
          endIndex: selectionStart + placeholder.length,
        });
        
        // 按位置排序
        return newRefs.sort((a, b) => a.startIndex - b.startIndex);
      });
      
      setChatInput(newText);
      
      // 如果是 copy 操作，粘贴到聊天框后清除 clipboard 状态
      if (clipboard && clipboard.type === 'copy') {
        setClipboard(null);
      }
      
      // 设置光标位置到引用文本之后
      setTimeout(() => {
        const newCursorPos = selectionStart + placeholder.length;
        textarea.setSelectionRange(newCursorPos, newCursorPos);
        textarea.focus();
      }, 0);
    }
  }, [clipboard, chatInput, mindMap, getNodePath, setClipboard]);

  // 将 mindmap 结构转换为文本描述（供 AI 理解）
  const convertMindMapToText = useCallback((): string => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeMap = new Map<string, { node: MindMapNode; children: string[] }>();
    const rootNodes: string[] = [];

    // 构建节点映射
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

    // 递归构建文本描述
    const buildNodeText = (nodeId: string, indent: number = 0): string => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return '';

      const { node, children } = nodeData;
      const indentStr = '  '.repeat(indent);
      const path = getNodePath(nodeId);
      const pathStr = path.join(' > ');
      let result = `${indentStr}- ${node.text || '未命名节点'} (ID: ${node.id}, 路径: ${pathStr})\n`;

      // 添加卡片信息
      const cards = nodeCardsMap[nodeId] || [];
      if (cards.length > 0) {
        cards.forEach((card: Card) => {
          const cardPath = [...path, card.title || '未命名卡片'].join(' > ');
          result += `${indentStr}  📄 ${card.title || '未命名卡片'} (ID: ${card.docId}, 路径: ${cardPath})\n`;
          if (card.content) {
            const contentPreview = card.content.length > 100 
              ? card.content.substring(0, 100) + '...' 
              : card.content;
            result += `${indentStr}    内容: ${contentPreview}\n`;
          }
        });
      }

      // 添加子节点
      children.forEach((childId) => {
        result += buildNodeText(childId, indent + 1);
      });

      return result;
    };

    let text = '当前思维导图结构：\n\n';
    rootNodes.forEach((rootId) => {
      text += buildNodeText(rootId, 0);
    });

    return text;
  }, [mindMap, getNodePath]);

  // 展开用户消息中的引用（@节点名 或 @卡片名）为详细信息
  const expandReferences = useCallback((message: string): string => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let expandedMessage = message;
    
    // 匹配所有 @引用
    const referencePattern = /@([^\s@]+)/g;
    const matches = Array.from(message.matchAll(referencePattern));
    
    // 从后往前替换，避免索引变化问题
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const refName = match[1];
      const startIndex = match.index!;
      const endIndex = startIndex + match[0].length;
      
      // 查找匹配的节点
      const matchedNode = mindMap.nodes.find(n => n.text === refName);
      if (matchedNode) {
        const path = getNodePath(matchedNode.id);
        const pathStr = path.join(' > ');
        const expandedRef = `@${refName} (节点ID: ${matchedNode.id}, 完整路径: ${pathStr})`;
        expandedMessage = expandedMessage.slice(0, startIndex) + expandedRef + expandedMessage.slice(endIndex);
        continue;
      }
      
      // 查找匹配的卡片
      for (const nodeId in nodeCardsMap) {
        const cards = nodeCardsMap[nodeId] || [];
        const matchedCard = cards.find((c: Card) => c.title === refName);
        if (matchedCard) {
          const nodePath = getNodePath(nodeId);
          const cardPath = [...nodePath, matchedCard.title || '未命名卡片'].join(' > ');
          // 包含完整内容，以便AI能够修改
          const fullContent = matchedCard.content || '(无内容)';
          const expandedRef = `@${refName} (卡片ID: ${matchedCard.docId}, 完整路径: ${cardPath}, 完整内容: ${fullContent})`;
          expandedMessage = expandedMessage.slice(0, startIndex) + expandedRef + expandedMessage.slice(endIndex);
          break;
        }
      }
    }
    
    return expandedMessage;
  }, [mindMap, getNodePath]);

  // 处理 AI 聊天发送
  const handleAIChatSend = useCallback(async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage = chatInput.trim();
    // 从引用列表中提取引用对象
    const references = chatInputReferences.map(ref => ({
      type: ref.type,
      id: ref.id,
      name: ref.name,
      path: ref.path,
    }));
    
    // 展开引用为详细信息（用于发送给 AI）
    const expandedMessage = expandReferences(userMessage);
    setChatInput('');
    setChatInputReferences([]);
    setIsChatLoading(true);

    // 先构建历史记录（在添加新消息之前，这样历史记录包含所有之前的对话）
    const historyBeforeNewMessage = chatMessages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant') // 只包含用户和助手消息，不包括操作气泡
      .map(msg => {
        // 如果是助手消息且包含错误信息，确保错误信息被包含
        let content = msg.content;
        // 如果消息内容为空但应该显示，使用默认文本
        if (!content && msg.role === 'assistant') {
          content = '已完成';
        }
        return {
          role: msg.role,
          content: content,
        };
      });
    
    console.log('发送给AI的历史记录（之前）:', historyBeforeNewMessage);
    
    // 先添加用户消息和临时的assistant消息
    let assistantMessageIndex: number;
    setChatMessages(prev => {
      const newMessages: Array<{ 
        role: 'user' | 'assistant' | 'operation'; 
        content: string; 
        references?: Array<{ type: 'node' | 'card'; id: string; name: string; path: string[] }>;
        operations?: any[];
        isExpanded?: boolean;
      }> = [
        ...prev, 
        { 
          role: 'user' as const, 
          content: userMessage,
          references: references.length > 0 ? references : undefined,
        }
      ];
      assistantMessageIndex = newMessages.length;
      newMessages.push({ role: 'assistant' as const, content: '' });
      return newMessages;
    });

    // 自动滚动到底部
    setTimeout(() => {
      if (chatMessagesEndRef.current) {
        chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      // 使用之前构建的历史记录（包含所有之前的对话）
      const history = historyBeforeNewMessage;

      // 获取当前 mindmap 结构描述
      const mindMapText = convertMindMapToText();
      
      // 使用展开后的消息发送给 AI
      const finalUserMessage = expandedMessage;

      // 构建系统提示
      const systemPrompt = `你是一个思维导图操作助手，专门帮助用户操作思维导图。

【你的核心职责】
1. **创建节点**：根据用户需求创建新的节点
2. **创建卡片**：在指定节点下创建卡片
3. **移动节点**：将节点移动到新的位置
4. **重命名**：修改节点或卡片的名称
5. **修改内容**：修改卡片的内容（当用户要求修改、美化、格式化卡片内容时使用）
6. **删除**：删除不需要的节点或卡片

【思维导图结构说明】
${mindMapText}

【操作格式】
你需要以 JSON 格式回复操作指令，格式如下：
\`\`\`json
{
  "operations": [
    {
      "type": "create_node",
      "parentId": "node_xxx",  // 父节点ID，如果是根节点则为null
      "text": "新节点名称"
    },
    {
      "type": "create_card",
      "nodeId": "node_xxx",
      "title": "卡片标题",
      "content": "卡片内容（可选）"
    },
    {
      "type": "move_node",
      "nodeId": "node_xxx",  // 要移动的节点ID
      "targetParentId": "node_yyy"  // 目标父节点ID（如果移动到根节点则为null）。**重要**：必须根据思维导图结构说明中的节点名称和路径，找到对应的节点ID
    },
    {
      "type": "move_card",
      "cardId": "card_xxx",  // 要移动的卡片ID
      "targetNodeId": "node_yyy"  // 目标节点ID（卡片将移动到该节点下）。**重要**：必须根据思维导图结构说明中的节点名称和路径，找到对应的节点ID
    },
    {
      "type": "rename_node",
      "nodeId": "node_xxx",
      "newText": "新名称"
    },
    {
      "type": "rename_card",
      "cardId": "card_xxx",
      "newTitle": "新标题"
    },
    {
      "type": "update_card_content",
      "cardId": "card_xxx",
      "newContent": "新的卡片内容"
    },
    {
      "type": "delete_node",
      "nodeId": "node_xxx"
    },
    {
      "type": "delete_card",
      "cardId": "card_xxx"
    }
  ]
}
\`\`\`

【重要规则】
1. 只输出 JSON 代码块（\`\`\`json ... \`\`\`）
2. 不要添加多余说明文字
3. 如果用户只是询问，不需要操作，则只回复文字说明，不要输出 JSON
4. **重要**：当用户要求"修改内容"、"美化格式"、"格式化"、"优化内容"等时，应该使用 \`update_card_content\` 操作修改卡片的内容（content），而不是使用 \`rename_card\` 修改标题（title）
5. 只有在用户明确要求修改标题/名称时，才使用 \`rename_card\` 或 \`rename_node\`
6. **移动节点时**：
   - 必须仔细查看思维导图结构说明，根据节点名称和完整路径找到正确的节点ID
   - 如果用户说"移动到XX文件夹/节点下"，必须在结构说明中找到名称匹配的节点，使用其ID作为 \`targetParentId\`
   - **重要**：节点ID格式通常是 \`node_xxx\`（如 \`node_1_6\`），不是卡片ID（卡片ID是长字符串）
   - 如果用户说"移动文件夹"，指的是移动节点（文件夹就是节点）
   - 如果找不到匹配的节点，应该回复错误信息而不是执行操作
7. **移动卡片时**：如果用户要移动的是卡片（不是节点），必须使用 \`move_card\` 操作，而不是 \`move_node\`。卡片ID通常是一个长字符串（如 \`692f8ab7f62755451fb3ffa\`），节点ID通常是 \`node_xxx\` 格式。**重要**：如果用户引用了卡片（如 @卡片名），要移动的应该是卡片，使用 \`move_card\` 操作。

用户指令：`;

      // 关闭之前的 WebSocket 连接
      if (chatWebSocketRef.current) {
        chatWebSocketRef.current.close();
        chatWebSocketRef.current = null;
      }

      // 创建 WebSocket 连接
      const { default: WebSocket } = await import('../components/socket');
      const wsPrefix = (window as any).UiContext?.wsPrefix || '';
      const wsUrl = `/d/${domainId}/ai/chat-ws`;
      const sock = new WebSocket(wsPrefix + wsUrl, false, true);
      chatWebSocketRef.current = sock;

      let accumulatedContent = '';
      let streamFinished = false;

      // WebSocket 消息处理
      sock.onmessage = (_, data: string) => {
        try {
          const msg = JSON.parse(data);
          
          if (msg.type === 'content') {
            accumulatedContent += msg.content;
            
            // 过滤掉 JSON 代码块，只显示文字内容（流式显示）
            let displayContent = accumulatedContent;
            const jsonMatch = displayContent.match(/```(?:json)?\n([\s\S]*?)\n```/);
            if (jsonMatch) {
              // 移除 JSON 代码块，只保留文字部分
              displayContent = displayContent.replace(/```(?:json)?\n[\s\S]*?\n```/g, '').trim();
            }
            
            // 实时更新显示内容（流式显示）
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: displayContent || '正在思考...',
                };
              }
              return newMessages;
            });
            
            // 自动滚动到底部
            setTimeout(() => {
              if (chatMessagesEndRef.current) {
                chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
              }
            }, 0);
          } else if (msg.type === 'done') {
            streamFinished = true;
            const finalContent = msg.content || accumulatedContent;
            
            // 提取 JSON 代码块
            const jsonMatch = finalContent.match(/```(?:json)?\n([\s\S]*?)\n```/);
            let textContent = finalContent.replace(/```(?:json)?\n[\s\S]*?\n```/g, '').trim();
            
            // 更新文字消息（最终内容）
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: textContent || '已完成',
                };
              }
              return newMessages;
            });
            
            // 滚动到底部
            setTimeout(() => {
              if (chatMessagesEndRef.current) {
                chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
              }
            }, 100);
            
              // 如果有 JSON 操作，创建操作气泡
              if (jsonMatch) {
                try {
                  const operations = JSON.parse(jsonMatch[1]);
                  if (operations.operations && Array.isArray(operations.operations)) {
                    // 调试：打印操作信息
                    console.log('AI 返回的操作:', operations.operations);
                    
                    // 添加操作气泡
                    setChatMessages(prev => {
                      const newMessages = [...prev];
                      newMessages.push({
                        role: 'operation',
                        content: `执行 ${operations.operations.length} 个操作`,
                        operations: operations.operations,
                        isExpanded: false,
                      });
                      return newMessages;
                    });
                    
                    // 自动执行操作
                    if (executeAIOperationsRef.current) {
                      executeAIOperationsRef.current(operations.operations).then((result) => {
                        if (result.success) {
                          Notification.success('AI 已执行操作');
                        } else {
                          // 如果有错误，将错误信息添加到聊天消息中，让AI能够看到并纠正
                          const errorText = result.errors.join('\n');
                          setChatMessages(prev => {
                            const newMessages = [...prev];
                            // 添加错误信息作为助手消息，这样AI在下次对话时能看到
                            newMessages.push({
                              role: 'assistant',
                              content: `操作执行失败，错误信息如下：\n${errorText}\n\n请根据错误信息重新执行操作，确保使用正确的节点ID。`,
                            });
                            return newMessages;
                          });
                          
                          // 滚动到底部显示错误信息
                          setTimeout(() => {
                            if (chatMessagesEndRef.current) {
                              chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
                            }
                          }, 100);
                        }
                      }).catch((err) => {
                        console.error('Failed to execute operations:', err);
                        const errorMsg = '执行操作失败: ' + (err.message || '未知错误');
                        Notification.error(errorMsg);
                        setChatMessages(prev => {
                          const newMessages = [...prev];
                          newMessages.push({
                            role: 'assistant',
                            content: `操作执行失败：${errorMsg}\n\n请重新执行操作。`,
                          });
                          return newMessages;
                        });
                      });
                    } else {
                      setTimeout(async () => {
                        if (executeAIOperationsRef.current) {
                          const result = await executeAIOperationsRef.current(operations.operations);
                          if (result.success) {
                            Notification.success('AI 已执行操作');
                          } else {
                            const errorText = result.errors.join('\n');
                            setChatMessages(prev => {
                              const newMessages = [...prev];
                              newMessages.push({
                                role: 'assistant',
                                content: `操作执行时出现错误：\n${errorText}\n\n请根据错误信息重新执行操作。`,
                              });
                              return newMessages;
                            });
                          }
                        }
                      }, 100);
                    }
                  }
                } catch (e) {
                  console.error('Failed to parse AI operations:', e);
                  Notification.error('解析 AI 操作失败: ' + (e.message || '未知错误'));
                }
              }
            
            // 关闭 WebSocket 连接
            if (chatWebSocketRef.current) {
              chatWebSocketRef.current.close();
              chatWebSocketRef.current = null;
            }
            setIsChatLoading(false);
          } else if (msg.type === 'error') {
            streamFinished = true;
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: `错误: ${msg.error || '未知错误'}`,
                };
              }
              return newMessages;
            });
            Notification.error('AI 聊天失败: ' + (msg.error || '未知错误'));
            setIsChatLoading(false);
            
            // 关闭 WebSocket 连接
            if (chatWebSocketRef.current) {
              chatWebSocketRef.current.close();
              chatWebSocketRef.current = null;
            }
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      sock.onclose = () => {
        chatWebSocketRef.current = null;
        if (!streamFinished) {
          setIsChatLoading(false);
        }
      };

      sock.onopen = () => {
        // 连接成功后发送消息
        sock.send(JSON.stringify({
          message: `${systemPrompt}\n\n用户指令：${finalUserMessage}`,
          history,
        }));
      };
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
  }, [chatInput, isChatLoading, chatMessages, convertMindMapToText, expandReferences]);

  // 执行 AI 操作
  const executeAIOperations = useCallback(async (operations: any[]): Promise<{ success: boolean; errors: string[] }> => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const errors: string[] = [];
    
    for (const op of operations) {
      try {
        if (op.type === 'create_node') {
          const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newChildNode: PendingCreate = {
            type: 'node',
            nodeId: op.parentId || '',
            text: op.text || '新节点',
            tempId,
          };
          
          pendingCreatesRef.current.set(tempId, newChildNode);
          setPendingCreatesCount(pendingCreatesRef.current.size);
          
          const tempNode: MindMapNode = {
            id: tempId,
            text: op.text || '新节点',
          };
          
          setMindMap(prev => ({
            ...prev,
            nodes: [...prev.nodes, tempNode],
            edges: op.parentId ? [...prev.edges, {
              id: `temp-edge-${Date.now()}`,
              source: op.parentId,
              target: tempId,
            }] : prev.edges,
          }));
          
          if (op.parentId) {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              if (!newSet.has(op.parentId)) {
                newSet.add(op.parentId);
                // 立即更新 ref，确保自动保存时能获取最新值
                expandedNodesRef.current = newSet;
                // 立即更新本地 mindMap 状态
                setMindMap(prev => {
                  const updated = {
                    ...prev,
                    nodes: prev.nodes.map(n =>
                      n.id === op.parentId
                        ? { ...n, expanded: true }
                        : n
                    ),
                  };
                  // 立即更新 ref，确保自动保存时能获取最新值
                  mindMapRef.current = updated;
                  return updated;
                });
                // 触发自动保存
                triggerExpandAutoSave();
              }
              return newSet;
            });
          }
        } else if (op.type === 'create_card') {
          const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newCard: PendingCreate = {
            type: 'card',
            nodeId: op.nodeId,
            title: op.title || '新卡片',
            tempId,
          };
          
          pendingCreatesRef.current.set(tempId, newCard);
          setPendingCreatesCount(pendingCreatesRef.current.size);
          
          if (!nodeCardsMap[op.nodeId]) {
            nodeCardsMap[op.nodeId] = [];
          }
          const maxOrder = nodeCardsMap[op.nodeId].length > 0 
            ? Math.max(...nodeCardsMap[op.nodeId].map((c: Card) => c.order || 0))
            : 0;
          
          const tempCard: Card = {
            docId: tempId,
            cid: 0,
            nodeId: op.nodeId,
            title: op.title || '新卡片',
            content: op.content || '',
            order: maxOrder + 1,
            updateAt: new Date().toISOString(),
          } as Card;
          
          nodeCardsMap[op.nodeId].push(tempCard);
          nodeCardsMap[op.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          setExpandedNodes(prev => new Set(prev).add(op.nodeId));
        } else if (op.type === 'move_node') {
          let nodeId = op.nodeId;
          const targetParentId = op.targetParentId;
          
          console.log('执行 move_node 操作:', { nodeId, targetParentId });
          console.log('所有可用节点:', mindMap.nodes.map(n => ({ id: n.id, text: n.text })));
          
          // 验证节点是否存在
          let node = mindMap.nodes.find(n => n.id === nodeId);
          
          // 如果找不到，尝试通过节点名称查找（用于调试）
          if (!node) {
            const nodeByName = mindMap.nodes.find(n => n.text === nodeId);
            if (nodeByName) {
              console.warn(`警告：nodeId "${nodeId}" 是节点名称，不是节点ID。应该使用节点ID "${nodeByName.id}"`);
              const errorMsg = `错误：nodeId "${nodeId}" 是节点名称，不是节点ID。请使用节点ID "${nodeByName.id}"`;
              Notification.error(errorMsg);
              errors.push(errorMsg);
              continue;
            }
          }
          
          // 如果 nodeId 不是节点ID，可能是卡片ID，提示用户使用 move_card
          if (!node) {
            console.log('nodeId 不是节点ID，可能是卡片ID:', nodeId);
            // 在所有节点中查找包含该卡片ID的卡片
            for (const nId in nodeCardsMap) {
              const cards = nodeCardsMap[nId] || [];
              const card = cards.find((c: Card) => c.docId === nodeId);
              if (card) {
                console.log('找到卡片，但使用了 move_node 操作，应该使用 move_card');
                const errorMsg = `检测到 ${nodeId} 是卡片ID，不是节点ID。移动卡片请使用 move_card 操作，而不是 move_node。`;
                Notification.error(errorMsg);
                errors.push(errorMsg);
                continue;
              }
            }
            console.error('节点不存在:', nodeId);
            console.log('所有节点ID:', mindMap.nodes.map(n => ({ id: n.id, text: n.text })));
            const errorMsg = `节点 ${nodeId} 不存在。请检查节点ID是否正确。`;
            Notification.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }
          
          // 如果 targetParentId 存在，验证目标节点是否存在
          if (targetParentId) {
            const targetNode = mindMap.nodes.find(n => n.id === targetParentId);
            
            // 如果找不到，尝试通过节点名称查找（用于调试）
            if (!targetNode) {
              const targetNodeByName = mindMap.nodes.find(n => n.text === targetParentId);
              if (targetNodeByName) {
                console.warn(`警告：targetParentId "${targetParentId}" 是节点名称，不是节点ID。应该使用节点ID "${targetNodeByName.id}"`);
                const errorMsg = `错误：targetParentId "${targetParentId}" 是节点名称，不是节点ID。请使用节点ID "${targetNodeByName.id}"`;
                Notification.error(errorMsg);
                errors.push(errorMsg);
                continue;
              }
              
              console.error('目标节点不存在:', targetParentId);
              console.log('所有节点ID:', mindMap.nodes.map(n => ({ id: n.id, text: n.text })));
              const errorMsg = `目标节点 ${targetParentId} 不存在。请检查节点ID是否正确。`;
              Notification.error(errorMsg);
              errors.push(errorMsg);
              continue;
            }
            console.log('目标节点:', { id: targetNode.id, text: targetNode.text });
          } else {
            console.log('移动到根节点');
          }
          
          // 检查是否会造成循环
          const isDescendant = (ancestorId: string, nodeId: string): boolean => {
            const children = mindMap.edges
              .filter(e => e.source === ancestorId)
              .map(e => e.target);
            if (children.includes(nodeId)) return true;
            return children.some(childId => isDescendant(childId, nodeId));
          };
          
          if (targetParentId && isDescendant(nodeId, targetParentId)) {
            const errorMsg = '不能将节点移动到自己的子节点下';
            Notification.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }
          
          // 移除旧的父节点连接
          const oldEdges = mindMap.edges.filter(e => e.target === nodeId);
          const newEdges = mindMap.edges.filter(e => !oldEdges.includes(e));
          
          // 创建新边
          if (targetParentId) {
            // 检查是否已经存在相同的边
            const existingEdge = newEdges.find(e => e.source === targetParentId && e.target === nodeId);
            if (!existingEdge) {
              newEdges.push({
                id: `edge-${targetParentId}-${nodeId}-${Date.now()}`,
                source: targetParentId,
                target: nodeId,
              });
            }
          }
          
          setMindMap(prev => ({
            ...prev,
            edges: newEdges,
          }));
          
          setPendingDragChanges(prev => new Set(prev).add(`node-${nodeId}`));
          
          // 如果目标节点存在，展开它以便看到移动后的节点
          if (targetParentId) {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              if (!newSet.has(targetParentId)) {
                newSet.add(targetParentId);
                // 立即更新 ref，确保自动保存时能获取最新值
                expandedNodesRef.current = newSet;
                // 立即更新本地 mindMap 状态
                setMindMap(prev => {
                  const updated = {
                    ...prev,
                    nodes: prev.nodes.map(n =>
                      n.id === targetParentId
                        ? { ...n, expanded: true }
                        : n
                    ),
                  };
                  // 立即更新 ref，确保自动保存时能获取最新值
                  mindMapRef.current = updated;
                  return updated;
                });
                // 触发自动保存
                triggerExpandAutoSave();
              }
              return newSet;
            });
          }
          
          Notification.success(`节点已移动到 ${targetParentId ? '目标节点下' : '根节点'}`);
        } else if (op.type === 'move_card') {
          const cardId = op.cardId;
          const targetNodeId = op.targetNodeId;
          
          console.log('执行 move_card 操作:', { cardId, targetNodeId });
          
          // 验证目标节点是否存在
          const targetNode = mindMap.nodes.find(n => n.id === targetNodeId);
          if (!targetNode) {
            console.error('目标节点不存在:', targetNodeId);
            console.log('所有节点ID:', mindMap.nodes.map(n => ({ id: n.id, text: n.text })));
            Notification.error(`目标节点 ${targetNodeId} 不存在。请检查节点ID是否正确。`);
            continue;
          }
          
          // 查找卡片
          let foundCard: Card | null = null;
          let sourceNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              sourceNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !sourceNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          // 如果卡片已经在目标节点下，不需要移动
          if (sourceNodeId === targetNodeId) {
            Notification.error('卡片已经在目标节点下');
            continue;
          }
          
          // 从原节点移除卡片
          const sourceCards = nodeCardsMap[sourceNodeId] || [];
          const cardIndex = sourceCards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            sourceCards.splice(cardIndex, 1);
            nodeCardsMap[sourceNodeId] = sourceCards;
          }
          
          // 添加到目标节点
          if (!nodeCardsMap[targetNodeId]) {
            nodeCardsMap[targetNodeId] = [];
          }
          
          // 计算新的 order（放在最后）
          const maxOrder = nodeCardsMap[targetNodeId].length > 0
            ? Math.max(...nodeCardsMap[targetNodeId].map((c: Card) => c.order || 0))
            : 0;
          
          // 更新卡片的 nodeId 和 order
          const updatedCard: Card = {
            ...foundCard,
            nodeId: targetNodeId,
            order: maxOrder + 1,
          };
          
          nodeCardsMap[targetNodeId].push(updatedCard);
          nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          
          // 记录拖动操作
          setPendingDragChanges(prev => new Set(prev).add(cardId));
          
          // 展开目标节点以便看到移动后的卡片
          setExpandedNodes(prev => {
            const newSet = new Set(prev);
            if (!newSet.has(targetNodeId)) {
              newSet.add(targetNodeId);
              // 立即更新 ref，确保自动保存时能获取最新值
              expandedNodesRef.current = newSet;
              // 立即更新本地 mindMap 状态
              setMindMap(prev => {
                const updated = {
                  ...prev,
                  nodes: prev.nodes.map(n =>
                    n.id === targetNodeId
                      ? { ...n, expanded: true }
                      : n
                  ),
                };
                // 立即更新 ref，确保自动保存时能获取最新值
                mindMapRef.current = updated;
                return updated;
              });
              // 触发自动保存
              triggerExpandAutoSave();
            }
            return newSet;
          });
          
          Notification.success(`卡片已移动到节点 ${targetNode.text} 下`);
        } else if (op.type === 'rename_node') {
          const nodeId = op.nodeId;
          const newText = op.newText;
          
          const node = mindMap.nodes.find(n => n.id === nodeId);
          if (!node) {
            Notification.error(`节点 ${nodeId} 不存在`);
            continue;
          }
          
          // 更新本地数据
          setMindMap(prev => ({
            ...prev,
            nodes: prev.nodes.map(n => 
              n.id === nodeId ? { ...n, text: newText } : n
            ),
          }));
          
          // 添加到待重命名列表
          const fileItem: FileItem = {
            type: 'node',
            id: nodeId,
            name: node.text || '未命名节点',
            nodeId: nodeId,
            level: 0,
          };
          
          setPendingRenames(prev => {
            const next = new Map(prev);
            next.set(nodeId, {
              file: fileItem,
              newName: newText,
              originalName: node.text || '未命名节点',
            });
            return next;
          });
        } else if (op.type === 'rename_card') {
          const cardId = op.cardId;
          const newTitle = op.newTitle;
          
          // 查找卡片
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          // 更新本地数据
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = { ...cards[cardIndex], title: newTitle };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
          
          // 添加到待重命名列表
          const fileItem: FileItem = {
            type: 'card',
            id: `card-${cardId}`,
            name: foundCard.title || '未命名卡片',
            nodeId: foundNodeId,
            cardId: cardId,
            level: 0,
          };
          
          setPendingRenames(prev => {
            const next = new Map(prev);
            next.set(`card-${cardId}`, {
              file: fileItem,
              newName: newTitle,
              originalName: foundCard!.title || '未命名卡片',
            });
            return next;
          });
        } else if (op.type === 'update_card_content') {
          const cardId = op.cardId;
          const newContent = op.newContent;
          
          // 查找卡片
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          // 更新本地数据
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = { ...cards[cardIndex], content: newContent };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
          
          // 添加到待修改列表（使用 pendingChanges）
          const fileItem: FileItem = {
            type: 'card',
            id: `card-${cardId}`,
            name: foundCard.title || '未命名卡片',
            nodeId: foundNodeId,
            cardId: cardId,
            level: 0,
          };
          
          // 更新 pendingChanges，确保 fileTree 能检测到变化
          setPendingChanges(prev => {
            const next = new Map(prev);
            next.set(`card-${cardId}`, {
              file: fileItem,
              content: newContent,
              originalContent: foundCard!.content || '',
            });
            // 返回新的 Map 实例，确保 React 能检测到变化
            return new Map(next);
          });
          
          // 如果当前选中的卡片就是被修改的卡片，更新编辑器内容
          if (selectedFile && selectedFile.type === 'card' && selectedFile.cardId === cardId) {
            setFileContent(newContent);
            // 延迟更新编辑器，确保 DOM 已更新
            setTimeout(() => {
              // 如果编辑器已经初始化，也更新编辑器的值
              if (editorRef.current) {
                editorRef.current.value = newContent;
                // 触发 input 事件，确保编辑器知道内容已更改
                const event = new Event('input', { bubbles: true });
                editorRef.current.dispatchEvent(event);
              }
              // 如果使用了 markdown 编辑器，也需要更新
              if (editorInstance) {
                try {
                  editorInstance.value(newContent);
                } catch (e) {
                  // 忽略错误
                }
              }
              // 尝试通过 jQuery 更新 textarea（如果存在）
              const $textarea = $(`#editor-wrapper-${selectedFile.id} textarea`);
              if ($textarea.length > 0) {
                $textarea.val(newContent);
                // 如果 textarea 有 data-markdown 属性，可能需要重新初始化编辑器
                if ($textarea.attr('data-markdown') === 'true') {
                  // 触发 change 事件
                  $textarea.trigger('change');
                }
              }
            }, 100);
          }
        } else if (op.type === 'delete_node') {
          const nodeId = op.nodeId;
          const node = mindMap.nodes.find(n => n.id === nodeId);
          if (!node) {
            Notification.error(`节点 ${nodeId} 不存在`);
            continue;
          }
          
          // 检查是否有子节点或卡片
          const hasCards = nodeCardsMap[nodeId]?.length > 0;
          const hasChildren = mindMap.edges.some(e => e.source === nodeId);
          
          if (hasCards || hasChildren) {
            Notification.error('无法删除：该节点包含子节点或卡片');
            continue;
          }
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(nodeId, {
              type: 'node',
              id: nodeId,
            });
            return next;
          });
          
          setMindMap(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => n.id !== nodeId),
            edges: prev.edges.filter(e => e.source !== nodeId && e.target !== nodeId),
          }));
        } else if (op.type === 'delete_card') {
          const cardId = op.cardId;
          
          // 查找卡片
          let foundNodeId: string | null = null;
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(cardId, {
              type: 'card',
              id: cardId,
              nodeId: foundNodeId!,
            });
            return next;
          });
          
          const cards = nodeCardsMap[foundNodeId!];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards.splice(cardIndex, 1);
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
        }
      } catch (error: any) {
        console.error(`Failed to execute operation ${op.type}:`, error);
        const errorMsg = `执行操作失败: ${op.type} - ${error.message || '未知错误'}`;
        Notification.error(errorMsg);
        errors.push(errorMsg);
      }
    }
    
    return { success: errors.length === 0, errors };
  }, [mindMap, setMindMap, selectedFile, editorInstance, setFileContent, triggerExpandAutoSave]);

  // 将 executeAIOperations 赋值给 ref
  useEffect(() => {
    executeAIOperationsRef.current = executeAIOperations;
  }, [executeAIOperations]);

  // 获取节点的所有子节点和卡片（递归）
  const getNodeChildren = useCallback((nodeId: string, visited: Set<string> = new Set()): { nodes: string[]; cards: string[] } => {
    if (visited.has(nodeId)) {
      return { nodes: [], cards: [] }; // 避免循环引用
    }
    visited.add(nodeId);
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cards: string[] = (nodeCardsMap[nodeId] || []).map((c: Card) => c.docId || '').filter(Boolean);
    const childNodes: string[] = mindMap.edges
      .filter(e => e.source === nodeId)
      .map(e => e.target)
      .filter(Boolean);
    
    // 递归获取所有子节点的子节点和卡片
    const allNodes: string[] = [...childNodes];
    const allCards: string[] = [...cards];
    
    for (const childNodeId of childNodes) {
      const childData = getNodeChildren(childNodeId, visited);
      allNodes.push(...childData.nodes);
      allCards.push(...childData.cards);
    }
    
    return { nodes: allNodes, cards: allCards };
  }, [mindMap.edges]);
  
  // 设置getNodeChildrenRef，供其他函数使用
  useEffect(() => {
    getNodeChildrenRef.current = getNodeChildren;
  }, [getNodeChildren]);

  // 导出节点为PDF
  const handleExportToPDF = useCallback(async (nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const node = mindMap.nodes.find(n => n.id === nodeId);
    if (!node) {
      Notification.error('节点不存在');
      return;
    }

    // 创建进度对话框
    const dialog = new Dialog({
      $body: `
        <div style="padding: 20px;">
          <div style="text-align: center; margin-bottom: 15px; font-size: 16px; font-weight: 500; color: #333;">
            正在导出PDF
          </div>
          <div id="pdf-export-status" style="text-align: center; margin-bottom: 10px; color: #666; font-size: 13px;">
            准备中...
          </div>
          <div class="bp5-progress-bar bp5-intent-primary bp5-no-stripes" style="margin-bottom: 10px;">
            <div id="pdf-export-progress" class="bp5-progress-meter" style="width: 0%; transition: width 0.3s ease;"></div>
          </div>
          <div id="pdf-export-current" style="text-align: center; color: #999; font-size: 12px; margin-top: 8px;">
          </div>
        </div>
      `,
    });

    const $status = dialog.$dom.find('#pdf-export-status');
    const $progress = dialog.$dom.find('#pdf-export-progress');
    const $current = dialog.$dom.find('#pdf-export-current');

    try {
      dialog.open();
      setContextMenu(null);

      // 动态导入jsPDF和html2canvas（使用ES模块）
      $status.text('正在加载PDF库...');
      $progress.css('width', '10%');
      
      const [{ jsPDF }, html2canvasModule] = await Promise.all([
        import('jspdf'),
        import('html2canvas'),
      ]);
      
      $status.text('正在收集数据...');
      $progress.css('width', '20%');
      
      // 递归收集所有节点和卡片数据（按order排序）
      interface ExportItem {
        type: 'node' | 'card';
        id: string;
        title: string;
        content: string;
        level: number;
        order: number;
        parentOrder?: string; // 父级序号，用于生成完整序号
      }

      const collectItems = (parentNodeId: string, level: number = 0, parentOrder: string = ''): ExportItem[] => {
        const items: ExportItem[] = [];
        
        // 获取子节点（按order排序）
        const childNodes = mindMap.edges
          .filter(e => e.source === parentNodeId)
          .map(e => {
            const childNode = mindMap.nodes.find(n => n.id === e.target);
            return childNode ? { id: childNode.id, node: childNode, order: childNode.order || 0 } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: MindMapNode; order: number }>;
        
        // 获取卡片（按order排序）
        const cards = (nodeCardsMap[parentNodeId] || [])
          .filter((card: Card) => !card.nodeId || card.nodeId === parentNodeId)
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        // 合并node和card，按照order混合排序
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node })),
          ...cards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c })),
        ];
        
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        // 生成序号并添加到items
        let itemIndex = 1;
        for (const child of allChildren) {
          const currentOrder = parentOrder ? `${parentOrder}.${itemIndex}` : `${itemIndex}`;
          
          if (child.type === 'node') {
            items.push({
              type: 'node',
              id: child.id,
              title: child.data.text || '未命名节点',
              content: '',
              level,
              order: child.order,
              parentOrder: currentOrder,
            });
            
            // 递归收集子节点
            const childItems = collectItems(child.id, level + 1, currentOrder);
            items.push(...childItems);
          } else {
            // 获取卡片内容（优先从pendingChanges获取最新内容）
            let cardContent = child.data.content || '';
            const cardFileId = `card-${child.id}`;
            const pendingChange = pendingChanges.get(cardFileId);
            if (pendingChange) {
              cardContent = pendingChange.content;
            }
            
            items.push({
              type: 'card',
              id: child.id,
              title: child.data.title || '未命名卡片',
              content: cardContent,
              level,
              order: child.order,
              parentOrder: currentOrder,
            });
          }
          
          itemIndex++;
        }
        
        return items;
      };

      const allItems = collectItems(nodeId, 0, '');
      const totalItems = allItems.length;
      
      $status.text(`共找到 ${totalItems} 个项目，开始生成PDF...`);
      $progress.css('width', '30%');
      
      // 创建PDF
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const contentWidth = pageWidth - 2 * margin;
      let yPos = margin;
      const lineHeight = 7;
      const titleHeight = 10;
      const sectionSpacing = 5;

      // 添加标题
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      const rootTitle = String(node.text || '未命名节点').trim();
      if (rootTitle && !isNaN(margin) && !isNaN(yPos)) {
        pdf.text(rootTitle, margin, yPos);
        yPos += titleHeight + sectionSpacing;
      }

      // 先渲染内容并记录每个项目的页码
      const tocItems: Array<{ order: string; title: string; page: number }> = [];
      let contentYPos = margin;

      // 添加内容页面（目录后从第2页开始）
      pdf.addPage();

      let processedCount = 0;
      for (const item of allItems) {
        processedCount++;
        const progressPercent = 30 + Math.round((processedCount / totalItems) * 50); // 30-80%
        $progress.css('width', `${progressPercent}%`);
        $status.text(`正在处理: ${item.parentOrder} ${item.title}`);
        $current.text(`${processedCount} / ${totalItems}`);
        // 记录当前页码作为目录项（目录占第1页，内容从第2页开始）
        const currentPageNumber = pdf.internal.getNumberOfPages();
        tocItems.push({
          order: item.parentOrder || '',
          title: item.title,
          page: currentPageNumber,
        });

        // 检查是否需要新页面
        if (contentYPos > pageHeight - margin - 20) {
          pdf.addPage();
          contentYPos = margin;
        }

        // 添加标题
        pdf.setFontSize(12 + (3 - item.level) * 2);
        pdf.setFont('helvetica', 'bold');
        const titleText = `${item.parentOrder || ''} ${item.title || '未命名'}`.trim();
        if (titleText) {
          const titleLines = pdf.splitTextToSize(titleText, contentWidth);
          // 确保 contentYPos 是有效数字
          if (isNaN(contentYPos) || contentYPos < margin) {
            contentYPos = margin;
          }
          // pdf.text 可以接受字符串数组
          if (Array.isArray(titleLines)) {
            titleLines.forEach((line: string) => {
              if (contentYPos + lineHeight > pageHeight - margin) {
                pdf.addPage();
                contentYPos = margin;
              }
              const lineText = String(line || '').trim();
              if (lineText && !isNaN(margin) && !isNaN(contentYPos)) {
                pdf.text(lineText, margin, contentYPos);
                contentYPos += lineHeight + 2;
              }
            });
          } else {
            const singleLine = String(titleLines || '').trim();
            if (singleLine && !isNaN(margin) && !isNaN(contentYPos)) {
              pdf.text(singleLine, margin, contentYPos);
              contentYPos += lineHeight + 2;
            }
          }
        }

        // 添加内容（仅对card）
        if (item.type === 'card' && item.content) {
          try {
            $status.text(`正在渲染: ${item.title}`);
            // 渲染Markdown为HTML
            const htmlContent = await fetch('/markdown', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                text: item.content,
                inline: false,
              }),
            }).then(res => res.text());
            
            if (htmlContent) {
              // 使用html2pdf.js将HTML转换为PDF图片，然后插入到当前PDF
              // 创建临时div来渲染HTML
              const tempDiv = document.createElement('div');
              tempDiv.style.width = `${contentWidth}mm`;
              tempDiv.style.padding = '10px';
              tempDiv.style.fontSize = '12px';
              tempDiv.style.lineHeight = '1.6';
              tempDiv.style.fontFamily = 'Arial, "Microsoft YaHei", "SimSun", sans-serif';
              tempDiv.style.color = '#000';
              tempDiv.style.backgroundColor = '#fff';
              tempDiv.style.position = 'absolute';
              tempDiv.style.left = '-9999px';
              tempDiv.style.top = '0';
              tempDiv.innerHTML = htmlContent;
              document.body.appendChild(tempDiv);
              
              // 等待图片加载完成
              await new Promise<void>((resolve) => {
                const images = tempDiv.querySelectorAll('img');
                if (images.length === 0) {
                  resolve();
                  return;
                }
                let loadedCount = 0;
                const totalImages = images.length;
                images.forEach((img) => {
                  if (img.complete) {
                    loadedCount++;
                    if (loadedCount === totalImages) resolve();
                  } else {
                    img.onload = () => {
                      loadedCount++;
                      if (loadedCount === totalImages) resolve();
                    };
                    img.onerror = () => {
                      loadedCount++;
                      if (loadedCount === totalImages) resolve();
                    };
                  }
                });
                setTimeout(() => resolve(), 5000);
              });
              
              // 使用html2canvas将HTML转换为canvas
              const canvas = await html2canvasModule.default(tempDiv, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                width: contentWidth * 3.779527559, // mm转px
              });
              
              // 清理临时div
              document.body.removeChild(tempDiv);
              
              // 计算图片尺寸（转换为mm）
              const imgWidth = contentWidth;
              const imgHeight = (canvas.height / canvas.width) * imgWidth;
              
              // 如果图片太高，需要分页
              const maxHeightPerPage = pageHeight - 2 * margin;
              if (imgHeight > maxHeightPerPage) {
                // 分页处理：将图片分成多个部分
                const parts = Math.ceil(imgHeight / maxHeightPerPage);
                const partHeight = imgHeight / parts;
                
                for (let i = 0; i < parts; i++) {
                  // 检查是否需要新页面
                  if (contentYPos > pageHeight - margin - 10) {
                    pdf.addPage();
                    contentYPos = margin;
                  }
                  
                  // 创建部分图片的canvas
                  const partCanvas = document.createElement('canvas');
                  partCanvas.width = canvas.width;
                  partCanvas.height = Math.ceil(canvas.height / parts);
                  const ctx = partCanvas.getContext('2d');
                  if (ctx) {
                    const sourceY = i * (canvas.height / parts);
                    const sourceHeight = canvas.height / parts;
                    
                    ctx.drawImage(
                      canvas,
                      0,
                      sourceY,
                      canvas.width,
                      sourceHeight,
                      0,
                      0,
                      canvas.width,
                      sourceHeight
                    );
                    
                    const partImgData = partCanvas.toDataURL('image/png');
                    pdf.addImage(partImgData, 'PNG', margin, contentYPos, imgWidth, partHeight);
                    contentYPos += partHeight;
                  }
                }
              } else {
                // 检查是否需要新页面
                if (contentYPos + imgHeight > pageHeight - margin) {
                  pdf.addPage();
                  contentYPos = margin;
                }
                
                // 将图片添加到PDF
                const imgData = canvas.toDataURL('image/png');
                pdf.addImage(imgData, 'PNG', margin, contentYPos, imgWidth, imgHeight);
                contentYPos += imgHeight;
              }
              
              contentYPos += sectionSpacing;
            }
          } catch (error) {
            console.error('渲染Markdown失败:', error);
            // 如果渲染失败，使用纯文本作为后备
            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'normal');
            
            // 提取HTML中的纯文本
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = item.content;
            const textContent = tempDiv.textContent || tempDiv.innerText || item.content;
            const contentLines = pdf.splitTextToSize(textContent.substring(0, 1000), contentWidth);
            
            for (const line of contentLines) {
              if (contentYPos + lineHeight > pageHeight - margin) {
                pdf.addPage();
                contentYPos = margin;
              }
              const lineText = String(line || '').trim();
              if (lineText && !isNaN(margin) && !isNaN(contentYPos)) {
                pdf.text(lineText, margin, contentYPos);
                contentYPos += lineHeight;
              }
            }
            
            contentYPos += sectionSpacing;
          }
        }

        contentYPos += sectionSpacing;
      }

      $status.text('正在生成目录...');
      $progress.css('width', '85%');
      
      // 现在在开头插入目录页
      pdf.insertPage(1);
      let tocYPos = margin;

      // 添加标题
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      const tocRootTitle = String(node.text || '未命名节点').trim();
      if (tocRootTitle && !isNaN(margin) && !isNaN(tocYPos)) {
        pdf.text(tocRootTitle, margin, tocYPos);
        tocYPos += titleHeight + sectionSpacing;
      }

      // 添加目录标题
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      if (!isNaN(margin) && !isNaN(tocYPos)) {
        pdf.text('目录', margin, tocYPos);
        tocYPos += lineHeight + 2;
      }

      // 绘制目录
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      for (const tocItem of tocItems) {
        if (tocYPos + lineHeight > pageHeight - margin) {
          pdf.addPage();
          tocYPos = margin;
        }
        
        const tocText = `${tocItem.order || ''} ${tocItem.title || '未命名'} ................ ${tocItem.page || 1}`;
        const tocTextStr = String(tocText).trim();
        if (tocTextStr && !isNaN(margin) && !isNaN(tocYPos)) {
          pdf.text(tocTextStr, margin, tocYPos);
          tocYPos += lineHeight;
        }
      }

      $status.text('正在保存PDF...');
      $progress.css('width', '95%');
      
      // 保存PDF
      const fileName = `${node.text || '未命名节点'}_${new Date().toISOString().split('T')[0]}.pdf`;
      pdf.save(fileName);
      
      $status.text('导出完成！');
      $progress.css('width', '100%');
      $current.text('');
      
      Notification.success('PDF导出成功');
      
      // 延迟关闭对话框
      setTimeout(() => {
        dialog.close();
      }, 1000);
    } catch (error: any) {
      console.error('导出PDF失败:', error);
      $status.text(`导出失败: ${error?.message || '未知错误'}`);
      $progress.css('width', '100%');
      $progress.css('background-color', '#dc3545');
      Notification.error(`导出PDF失败: ${error?.message || '未知错误'}`);
      
      // 延迟关闭对话框
      setTimeout(() => {
        dialog.close();
      }, 3000);
    }
  }, [mindMap.nodes, mindMap.edges, pendingChanges]);

  // 多选模式：切换选择状态
  const handleToggleSelect = useCallback((file: FileItem) => {
    if (!isMultiSelectMode) return;
    
    setSelectedItems(prev => {
      const next = new Set(prev);
      const isSelected = next.has(file.id);
      
      if (isSelected) {
        // 取消选择：移除当前项
        next.delete(file.id);
        
        // 如果是节点，同时取消选择所有子节点和卡片
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const children = getNodeChildrenRef.current(file.nodeId || '');
          children.nodes.forEach(nodeId => {
            // 找到对应的file.id
            const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
            if (nodeFile) next.delete(nodeFile.id);
          });
          children.cards.forEach(cardId => {
            // 找到对应的file.id
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile) next.delete(cardFile.id);
          });
        }
      } else {
        // 选择：添加当前项
        next.add(file.id);
        
        // 如果是节点，同时选择所有子节点和卡片
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const children = getNodeChildrenRef.current(file.nodeId || '');
          children.nodes.forEach(nodeId => {
            const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
            if (nodeFile) next.add(nodeFile.id);
          });
          children.cards.forEach(cardId => {
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile) next.add(cardFile.id);
          });
        }
      }
      
      return next;
    });
  }, [isMultiSelectMode, fileTree]);

  // 批量删除选中的项目
  const handleBatchDelete = useCallback(() => {
    if (selectedItems.size === 0) {
      Notification.info('请先选择要删除的项目');
      return;
    }
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const itemsToDelete: FileItem[] = [];
    const allNodeIdsToDelete = new Set<string>();
    const allCardIdsToDelete = new Set<string>();
    
    // 收集所有要删除的项目（包括递归的子节点和card）
    for (const fileId of selectedItems) {
      const file = fileTree.find(f => f.id === fileId);
      if (file) {
        itemsToDelete.push(file);
        
        // 如果是node，递归收集所有子节点和card
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const nodeId = file.nodeId || '';
          const children = getNodeChildrenRef.current(nodeId);
          children.nodes.forEach(childNodeId => {
            allNodeIdsToDelete.add(childNodeId);
            // 找到对应的FileItem并添加到itemsToDelete
            const childFile = fileTree.find(f => f.type === 'node' && f.nodeId === childNodeId);
            if (childFile && !itemsToDelete.find(f => f.id === childFile.id)) {
              itemsToDelete.push(childFile);
            }
          });
          children.cards.forEach(cardId => {
            allCardIdsToDelete.add(cardId);
            // 找到对应的FileItem并添加到itemsToDelete
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile && !itemsToDelete.find(f => f.id === cardFile.id)) {
              itemsToDelete.push(cardFile);
            }
          });
        }
        
        // 记录要删除的节点和card ID
        if (file.type === 'node') {
          allNodeIdsToDelete.add(file.nodeId || '');
        } else if (file.type === 'card') {
          allCardIdsToDelete.add(file.cardId || '');
        }
      }
    }
    
    // 清理待新建状态：如果是临时节点或卡片，清理所有相关的pending操作
    const tempNodeIds: string[] = [];
    const tempCardIds: string[] = [];
    
    for (const file of itemsToDelete) {
      if (file.type === 'node') {
        const nodeId = file.nodeId || '';
        if (nodeId.startsWith('temp-node-')) {
          cleanupPendingForTempItem(file);
          tempNodeIds.push(nodeId);
        }
      } else if (file.type === 'card') {
        const cardId = file.cardId || '';
        if (cardId.startsWith('temp-card-')) {
          cleanupPendingForTempItem(file);
          tempCardIds.push(cardId);
        }
      }
    }
    
    // 添加到待删除列表（只添加已存在的项目，临时项目不需要）
    setPendingDeletes(prev => {
      const next = new Map(prev);
      
      // 添加所有节点（包括递归的子节点）
      for (const nodeId of allNodeIdsToDelete) {
        if (!tempNodeIds.includes(nodeId)) {
          next.set(nodeId, {
            type: 'node',
            id: nodeId,
          });
        }
      }
      
      // 添加所有card（包括递归的子card）
      for (const cardId of allCardIdsToDelete) {
        if (!tempCardIds.includes(cardId)) {
          // 找到card所属的nodeId
          const cardFile = itemsToDelete.find(f => f.type === 'card' && f.cardId === cardId);
          const cardNodeId = cardFile?.nodeId || 
            mindMap.nodes.find(n => {
              const cards = nodeCardsMap[n.id] || [];
              return cards.some((c: Card) => c.docId === cardId);
            })?.id;
          
          next.set(cardId, {
            type: 'card',
            id: cardId,
            nodeId: cardNodeId,
          });
        }
      }
      
      return next;
    });
    
    // 从 mindMap 中移除节点（前端显示）：递归移除所有子节点
    const nodeIdsArray = Array.from(allNodeIdsToDelete);
    if (nodeIdsArray.length > 0) {
      setMindMap(prev => ({
        ...prev,
        nodes: prev.nodes.filter(n => !nodeIdsArray.includes(n.id)),
        edges: prev.edges.filter(e => 
          !nodeIdsArray.includes(e.source) && !nodeIdsArray.includes(e.target)
        ),
      }));
    }
    
    // 从 nodeCardsMap 中移除卡片（前端显示）：递归移除所有card
    const cardIdsArray = Array.from(allCardIdsToDelete);
    for (const cardId of cardIdsArray) {
      // 找到card所属的nodeId
      for (const nodeIdKey in nodeCardsMap) {
        const cards = nodeCardsMap[nodeIdKey];
        const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          break;
        }
      }
    }
    
    // 清空选择
    setSelectedItems(new Set());
    const totalItemsToDelete = allNodeIdsToDelete.size + allCardIdsToDelete.size;
    Notification.success(`已标记 ${totalItemsToDelete} 个项目待删除（包括 ${allNodeIdsToDelete.size} 个节点和 ${allCardIdsToDelete.size} 个卡片），请保存以确认删除`);
  }, [selectedItems, fileTree, cleanupPendingForTempItem]);

  // 删除节点或卡片（前端操作）
  const handleDelete = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      // 对于节点，id就是nodeId
      const nodeId = file.nodeId || file.id || '';
      
      if (!nodeId) {
        Notification.error('无法删除：节点ID无效');
        setContextMenu(null);
        return;
      }
      
      // 检查节点是否已经在待删除列表中
      if (pendingDeletes.has(nodeId)) {
        Notification.info('该节点已经在待删除列表中');
        setContextMenu(null);
        return;
      }
      
      // 如果是临时节点（待新建的），清理所有相关的pending操作（包括其下的临时card）
      const isTempNode = nodeId.startsWith('temp-node-');
      
      if (isTempNode) {
        cleanupPendingForTempItem(file);
        // 临时节点不需要添加到pendingDeletes，因为它还没有真正创建
      } else {
        // 递归获取所有子节点和card
        const children = getNodeChildrenRef.current ? getNodeChildrenRef.current(nodeId) : { nodes: [], cards: [] };
        
        // 添加到待删除列表：先添加子节点和card，再添加当前节点
        setPendingDeletes(prev => {
          const next = new Map(prev);
          
          // 先添加所有子节点
          for (const childNodeId of children.nodes) {
            if (!next.has(childNodeId)) {
              next.set(childNodeId, {
                type: 'node',
                id: childNodeId,
              });
            }
          }
          
          // 再添加所有card
          for (const cardId of children.cards) {
            if (!next.has(cardId)) {
              // 找到card所属的nodeId
              const cardNodeId = mindMap.nodes.find(n => {
                const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                const cards = nodeCardsMap[n.id] || [];
                return cards.some((c: Card) => c.docId === cardId);
              })?.id;
              
              next.set(cardId, {
                type: 'card',
                id: cardId,
                nodeId: cardNodeId,
              });
            }
          }
          
          // 最后添加当前节点
          next.set(nodeId, {
            type: 'node',
            id: nodeId,
          });
          
          return next;
        });
        
        // 从 mindMap 中移除（前端显示）：递归移除所有子节点和card
        const allNodeIdsToDelete = [nodeId, ...children.nodes];
        setMindMap(prev => ({
          ...prev,
          nodes: prev.nodes.filter(n => !allNodeIdsToDelete.includes(n.id)),
          edges: prev.edges.filter(e => 
            !allNodeIdsToDelete.includes(e.source) && !allNodeIdsToDelete.includes(e.target)
          ),
        }));
        
        // 从 nodeCardsMap 中移除所有card（前端显示）
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        for (const cardId of children.cards) {
          // 找到card所属的nodeId
          for (const nodeIdKey in nodeCardsMap) {
            const cards = nodeCardsMap[nodeIdKey];
            const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
            if (cardIndex >= 0) {
              cards.splice(cardIndex, 1);
              (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              setNodeCardsMapVersion(prev => prev + 1);
              break;
            }
          }
        }
      }
    } else if (file.type === 'card') {
      const cardId = file.cardId || '';
      
      // 如果是临时卡片（待新建的），清理所有相关的pending操作
      if (cardId.startsWith('temp-card-')) {
        cleanupPendingForTempItem(file);
        // 临时卡片不需要添加到pendingDeletes，因为它还没有真正创建
      } else {
        // 只有已存在的卡片才添加到待删除列表
      setPendingDeletes(prev => {
        const next = new Map(prev);
          next.set(cardId, {
          type: 'card',
            id: cardId,
          nodeId: file.nodeId,
        });
        return next;
      });
      }
      
      // 从 nodeCardsMap 中移除（前端显示）
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    setContextMenu(null);
  }, [mindMap.edges, mindMap.nodes, pendingDeletes, cleanupPendingForTempItem]);

  // 拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent, file: FileItem) => {
    setDraggedFile(file);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', file.id);
  }, []);

  // 拖拽结束
  const handleDragEnd = useCallback(() => {
    // 清除所有延迟清除定时器
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
      dragLeaveTimeoutRef.current = null;
    }
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    
    setDraggedFile(null);
    setDragOverFile(null);
    setDropPosition('after');
    lastDragOverFileRef.current = null;
    lastDropPositionRef.current = 'after';
  }, []);

  // 拖拽悬停（使用节流优化性能）
  const handleDragOver = useCallback((e: React.DragEvent, file: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 取消 dragLeave 的延迟清除
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
      dragLeaveTimeoutRef.current = null;
    }
    
    if (!draggedFile || draggedFile.id === file.id) {
      // 如果当前悬停的文件和上次一样，不需要更新
      if (lastDragOverFileRef.current?.id === file.id) {
        return;
      }
      // 延迟清除，避免频繁更新
      if (dragOverTimeoutRef.current) {
        clearTimeout(dragOverTimeoutRef.current);
      }
      dragOverTimeoutRef.current = setTimeout(() => {
        if (lastDragOverFileRef.current?.id !== file.id) {
          setDragOverFile(null);
          lastDragOverFileRef.current = null;
        }
      }, 100);
      return;
    }
    
    // 如果悬停的文件和上次一样，只检查位置是否需要更新
    if (lastDragOverFileRef.current?.id === file.id) {
      // 检测放置位置（之前、之后、或内部）
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseY = e.clientY;
      const itemMiddle = rect.top + rect.height / 2;
      
      let newDropPosition: 'before' | 'after' | 'into' = 'after';
      
      if (draggedFile.type === 'card') {
        if (file.type === 'node') {
          newDropPosition = 'into';
        } else if (file.type === 'card') {
          newDropPosition = mouseY < itemMiddle ? 'before' : 'after';
        }
      } else if (draggedFile.type === 'node' && file.type === 'node') {
        // 检查是否在同一父节点下
        const draggedNodeId = draggedFile.nodeId || '';
        const targetNodeId = file.nodeId || '';
        
        // 找到拖动节点和目标节点的父节点
        const draggedParentEdge = mindMap.edges.find(e => e.target === draggedNodeId);
        const targetParentEdge = mindMap.edges.find(e => e.target === targetNodeId);
        const draggedParentId = draggedParentEdge?.source;
        const targetParentId = targetParentEdge?.source;
        
        // 如果两个节点有相同的父节点，可以进行排序（before/after）
        if (draggedParentId && targetParentId && draggedParentId === targetParentId && draggedNodeId !== targetNodeId) {
          // 在同一父节点下，根据鼠标位置判断是之前还是之后
          newDropPosition = mouseY < itemMiddle ? 'before' : 'after';
        } else {
          // 不同父节点或没有父节点，放在内部（作为子节点）
          newDropPosition = 'into';
        }
      }
      
      // 只在位置改变时更新
      if (lastDropPositionRef.current !== newDropPosition) {
        setDropPosition(newDropPosition);
        lastDropPositionRef.current = newDropPosition;
      }
      return;
    }
    
    // 检测放置位置（之前、之后、或内部）
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseY = e.clientY;
    const itemMiddle = rect.top + rect.height / 2;
    
    let newDropPosition: 'before' | 'after' | 'into' = 'after';
    
    // 如果拖动的是卡片，可以放在节点内部或其他卡片之前/之后
    if (draggedFile.type === 'card') {
      if (file.type === 'node') {
        // 拖动到节点上，放在内部（最后）
        newDropPosition = 'into';
      } else if (file.type === 'card') {
        // 拖动到卡片上，根据鼠标位置判断是之前还是之后
        if (mouseY < itemMiddle) {
          newDropPosition = 'before';
        } else {
          newDropPosition = 'after';
        }
      }
    } else if (draggedFile.type === 'node' && file.type === 'node') {
      // 检查是否在同一父节点下
      const draggedNodeId = draggedFile.nodeId || '';
      const targetNodeId = file.nodeId || '';
      
      // 找到拖动节点和目标节点的父节点
      const draggedParentEdge = mindMap.edges.find(e => e.target === draggedNodeId);
      const targetParentEdge = mindMap.edges.find(e => e.target === targetNodeId);
      const draggedParentId = draggedParentEdge?.source;
      const targetParentId = targetParentEdge?.source;
      
      // 如果两个节点有相同的父节点，可以进行排序（before/after）
      if (draggedParentId && targetParentId && draggedParentId === targetParentId && draggedNodeId !== targetNodeId) {
        // 在同一父节点下，根据鼠标位置判断是之前还是之后
        newDropPosition = mouseY < itemMiddle ? 'before' : 'after';
      } else {
        // 不同父节点或没有父节点，放在内部（作为子节点）
        newDropPosition = 'into';
      }
    }
    
    // 清除之前的延迟更新
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    
    // 更新状态
    setDragOverFile(file);
    setDropPosition(newDropPosition);
    lastDragOverFileRef.current = file;
    lastDropPositionRef.current = newDropPosition;
  }, [draggedFile, mindMap.edges]);

  // 拖拽离开
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 清除之前的延迟清除定时器
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
    }
    
    // 延迟清除，如果很快又有 dragOver 事件，会被取消
    dragLeaveTimeoutRef.current = setTimeout(() => {
      setDragOverFile(null);
      dragLeaveTimeoutRef.current = null;
    }, 50);
  }, []);

  // 放置（纯前端操作，不调用后端）
  const handleDrop = useCallback((e: React.DragEvent, targetFile: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedFile || draggedFile.id === targetFile.id) {
      setDragOverFile(null);
      return;
    }

    try {
      // 如果拖动的是卡片，可以移动到其他节点下
      if (draggedFile.type === 'card' && targetFile.type === 'node') {
        // 拖动到节点，放在最后
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const targetNodeCards = nodeCardsMap[targetFile.nodeId] || [];
        const maxOrder = targetNodeCards.length > 0 
          ? Math.max(...targetNodeCards.map((c: Card) => c.order || 0))
          : 0;
        const newOrder = maxOrder + 1;
        
        // 从原节点移除
        if (nodeCardsMap[draggedFile.nodeId || '']) {
          const cards = nodeCardsMap[draggedFile.nodeId || ''];
          const cardIndex = cards.findIndex((c: Card) => c.docId === draggedFile.cardId);
          if (cardIndex >= 0) {
            const [card] = cards.splice(cardIndex, 1);
            // 更新卡片的 nodeId 和 order
            card.nodeId = targetFile.nodeId || '';
            card.order = newOrder;
            
            // 添加到目标节点
            if (!nodeCardsMap[targetFile.nodeId]) {
              nodeCardsMap[targetFile.nodeId] = [];
            }
            nodeCardsMap[targetFile.nodeId].push(card);
            // 按 order 排序
            nodeCardsMap[targetFile.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            
            // 记录拖动操作，待保存
            setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
          }
        }
      } else if (draggedFile.type === 'card' && targetFile.type === 'card') {
        // 如果拖动卡片到另一个卡片上，移动到该卡片所在的节点，并根据位置设置顺序
        const targetNodeId = targetFile.nodeId;
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const targetNodeCards = nodeCardsMap[targetNodeId] || [];
        const targetCard = targetNodeCards.find((c: Card) => c.docId === targetFile.cardId);
        const targetOrder = targetCard?.order || 0;
        
        // 如果拖动到同一个节点，需要调整顺序
        if (draggedFile.nodeId === targetNodeId) {
          // 获取所有卡片并重新排序
          const allCards = [...targetNodeCards].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          const draggedCardIndex = allCards.findIndex((c: Card) => c.docId === draggedFile.cardId);
          const targetCardIndex = allCards.findIndex((c: Card) => c.docId === targetFile.cardId);
          
          if (draggedCardIndex >= 0 && targetCardIndex >= 0 && draggedCardIndex !== targetCardIndex) {
            // 移除被拖动的卡片
            const [draggedCard] = allCards.splice(draggedCardIndex, 1);
            // 根据 dropPosition 插入到目标位置
            let newIndex: number;
            if (dropPosition === 'before') {
              newIndex = targetCardIndex;
            } else {
              // after
              newIndex = draggedCardIndex < targetCardIndex ? targetCardIndex : targetCardIndex + 1;
            }
            allCards.splice(newIndex, 0, draggedCard);
            
            // 更新所有卡片的 order
            allCards.forEach((card, index) => {
              card.order = index + 1;
            });
            
            // 更新 nodeCardsMap
            nodeCardsMap[targetNodeId] = allCards;
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            
            // 记录拖动操作，待保存（只记录被拖动的卡片，不记录所有受影响的卡片）
            setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
            
            // 触发 fileTree 重新计算
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else {
          // 移动到不同节点，根据 dropPosition 设置顺序
          const draggedCard = nodeCardsMap[draggedFile.nodeId || '']?.find((c: Card) => c.docId === draggedFile.cardId);
          if (!draggedCard) {
            setDragOverFile(null);
            return;
          }
          
          let newOrder: number;
          if (dropPosition === 'before') {
            // 放在目标卡片之前
            newOrder = targetOrder;
            // 目标卡片及其后的卡片需要 order +1
            targetNodeCards.forEach((card: Card) => {
              if (card.order && card.order >= targetOrder) {
                card.order = (card.order || 0) + 1;
              }
            });
          } else {
            // after - 放在目标卡片之后
            newOrder = targetOrder + 1;
            // 目标卡片之后的卡片需要 order +1
            targetNodeCards.forEach((card: Card) => {
              if (card.order && card.order > targetOrder) {
                card.order = (card.order || 0) + 1;
              }
            });
          }
          
          // 从原节点移除
          if (nodeCardsMap[draggedFile.nodeId || '']) {
            const cards = nodeCardsMap[draggedFile.nodeId || ''];
            const cardIndex = cards.findIndex((c: Card) => c.docId === draggedFile.cardId);
            if (cardIndex >= 0) {
              cards.splice(cardIndex, 1);
            }
          }
          
          // 添加到目标节点
          if (!nodeCardsMap[targetNodeId]) {
            nodeCardsMap[targetNodeId] = [];
          }
          draggedCard.nodeId = targetNodeId;
          draggedCard.order = newOrder;
          nodeCardsMap[targetNodeId].push(draggedCard);
          // 按 order 排序
          nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          
          // 记录拖动操作，待保存（只记录被拖动的卡片，不记录所有受影响的卡片）
          setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
          
          // 触发 fileTree 重新计算
          setNodeCardsMapVersion(prev => prev + 1);
        }
      } else if (draggedFile.type === 'node' && targetFile.type === 'node') {
        const draggedNodeId = draggedFile.nodeId || '';
        const targetNodeId = targetFile.nodeId || '';
        
        // 找到拖动节点和目标节点的父节点
        const draggedParentEdge = mindMap.edges.find(e => e.target === draggedNodeId);
        const targetParentEdge = mindMap.edges.find(e => e.target === targetNodeId);
        const draggedParentId = draggedParentEdge?.source;
        const targetParentId = targetParentEdge?.source;
        
        // 检查是否在同一父节点下（排序模式）
        const isSameParent = draggedParentId && targetParentId && draggedParentId === targetParentId;
        
        if (isSameParent && dropPosition !== 'into') {
          // 排序模式：在同一父节点下改变顺序
          // 获取同一父节点下的所有子节点（按order排序）
          const siblingNodes = mindMap.edges
            .filter(e => e.source === draggedParentId)
            .map(e => {
              const node = mindMap.nodes.find(n => n.id === e.target);
              return node ? { id: node.id, node, order: node.order || 0 } : null;
            })
            .filter(Boolean)
            .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: MindMapNode; order: number }>;
          
          const draggedNodeIndex = siblingNodes.findIndex(n => n.id === draggedNodeId);
          const targetNodeIndex = siblingNodes.findIndex(n => n.id === targetNodeId);
          
          if (draggedNodeIndex >= 0 && targetNodeIndex >= 0 && draggedNodeIndex !== targetNodeIndex) {
            // 移除被拖动的节点
            const [draggedNodeData] = siblingNodes.splice(draggedNodeIndex, 1);
            
            // 根据 dropPosition 插入到目标位置
            let newIndex: number;
            if (dropPosition === 'before') {
              newIndex = targetNodeIndex;
            } else {
              // after
              newIndex = draggedNodeIndex < targetNodeIndex ? targetNodeIndex : targetNodeIndex + 1;
            }
            siblingNodes.splice(newIndex, 0, draggedNodeData);
            
            // 更新所有节点的 order
            siblingNodes.forEach((nodeData, index) => {
              nodeData.node.order = index + 1;
            });
            
            // 更新 mindMap
            setMindMap(prev => ({
              ...prev,
              nodes: prev.nodes.map(n => {
                const updatedNode = siblingNodes.find(sn => sn.id === n.id);
                return updatedNode ? { ...n, order: updatedNode.node.order } : n;
              }),
            }));
            
            // 记录拖动操作，待保存
            setPendingDragChanges(prev => {
              const newSet = new Set(prev);
              newSet.add(`node-${draggedNodeId}`);
              return newSet;
            });
            
            // 触发 fileTree 重新计算
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else {
          // 移动模式：改变父节点（包括所有嵌套结构）
          // 需要检查是否会造成循环（不能将节点拖到自己或自己的子节点下）
          const isDescendant = (ancestorId: string, nodeId: string): boolean => {
            // 找到所有以 ancestorId 为 source 的边
            const children = mindMap.edges
              .filter(e => e.source === ancestorId)
              .map(e => e.target);
            
            // 如果 nodeId 是直接子节点，返回 true
            if (children.includes(nodeId)) {
              return true;
            }
            
            // 递归检查所有子节点
            return children.some(childId => isDescendant(childId, nodeId));
          };
          
          // 如果目标节点是拖动节点的子节点，不允许移动
          if (isDescendant(draggedNodeId, targetNodeId)) {
            Notification.error('不能将节点移动到自己的子节点下');
            setDragOverFile(null);
            return;
          }
          
          // 检查是否已经是目标节点的子节点
          const existingEdge = mindMap.edges.find(
            e => e.source === targetNodeId && e.target === draggedNodeId
          );
          
          if (!existingEdge) {
            // 获取拖动节点的所有子节点（递归，用于记录拖动操作）
            const getAllDescendants = (nodeId: string): string[] => {
              const directChildren = mindMap.edges
                .filter(e => e.source === nodeId)
                .map(e => e.target);
              
              const allDescendants = [...directChildren];
              for (const childId of directChildren) {
                allDescendants.push(...getAllDescendants(childId));
              }
              return allDescendants;
            };
            
            const draggedNodeDescendants = getAllDescendants(draggedNodeId);
            
            // 获取目标节点的子节点数量（用于设置order）
            const targetChildren = mindMap.edges.filter(e => e.source === targetNodeId);
            const targetChildNodes = targetChildren.map(e => {
              const node = mindMap.nodes.find(n => n.id === e.target);
              return node ? { id: node.id, order: node.order || 0 } : null;
            }).filter(Boolean) as Array<{ id: string; order: number }>;
            const maxOrder = targetChildNodes.length > 0 
              ? Math.max(...targetChildNodes.map(n => n.order))
              : 0;
            const newOrder = maxOrder + 1;
            
            // 移除旧的父节点连接（只移除拖动节点本身的父连接）
            const oldEdges = mindMap.edges.filter(
              e => e.target === draggedNodeId
            );
            
            // 删除旧边
            const newEdges = mindMap.edges.filter(
              e => !oldEdges.includes(e)
            );
            
            // 创建新边（拖动节点到目标节点）
            const newEdge: MindMapEdge = {
              id: `edge-${targetNodeId}-${draggedNodeId}-${Date.now()}`,
              source: targetNodeId,
              target: draggedNodeId,
            };
            
            newEdges.push(newEdge);
            
            // 更新拖动节点的order
            const draggedNode = mindMap.nodes.find(n => n.id === draggedNodeId);
            
            // 更新本地数据
            setMindMap(prev => ({
              ...prev,
              edges: newEdges,
              nodes: prev.nodes.map(n => 
                n.id === draggedNodeId ? { ...n, order: newOrder } : n
              ),
            }));
            
            // 记录拖动操作，待保存（记录拖动节点，所有子节点会自动迁移）
            setPendingDragChanges(prev => {
              const newSet = new Set(prev);
              newSet.add(`node-${draggedNodeId}`);
              // 所有子节点的 edges 也会被影响，但只需要记录拖动节点即可
              // 因为保存时会处理所有相关的 edges
              return newSet;
            });
            
            // 触发 fileTree 重新计算
            setNodeCardsMapVersion(prev => prev + 1);
          }
        }
      }
      
      // 强制重新渲染文件树（通过更新 mindMap 触发 fileTree 重新计算）
      setMindMap(prev => ({ ...prev }));
      
      // 强制触发 fileTree 重新计算（通过更新一个状态）
      // 由于 fileTree 依赖于 mindMap，上面的 setMindMap 应该已经足够
      // 但为了确保 nodeCardsMap 的更新也被检测到，我们需要触发一次重新渲染
      // 实际上，由于我们直接修改了 (window as any).UiContext.nodeCardsMap
      // 我们需要强制 React 重新渲染
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      
      setDragOverFile(null);
      setDropPosition('after');
    } catch (error: any) {
      console.error('移动失败:', error);
      setDragOverFile(null);
      setDropPosition('after');
    }
  }, [draggedFile, dropPosition, mindMap.edges, mindMap.nodes]);

  // 使用 ref 跟踪当前选中的文件ID，避免在fileContent变化时重新初始化
  const selectedFileIdRef = useRef<string | null>(null);
  const selectedFileRef = useRef<FileItem | null>(null); // 用于在onChange回调中访问最新的selectedFile
  const isInitializingRef = useRef(false);
  
  // 初始化编辑器（只在选择文件变化时）
  useEffect(() => {
    if (!editorRef.current || !selectedFile) {
      return;
    }

    // 如果文件ID没有变化，不重新初始化
    if (selectedFileIdRef.current === selectedFile.id && editorInstance) {
      return;
    }
    
    selectedFileIdRef.current = selectedFile.id;
    isInitializingRef.current = true;

    // 先销毁旧的编辑器
    if (editorInstance) {
      try {
        editorInstance.destroy();
      } catch (error) {
        console.warn('Error destroying editor:', error);
      }
      setEditorInstance(null);
    }

    let currentEditor: any = null;

    // 使用 requestAnimationFrame 确保 DOM 完全准备好
    let retryCount = 0;
    const maxRetries = 10;
    
    const initEditor = () => {
      // 再次检查元素是否还在DOM中，并且有父元素
      if (!editorRef.current) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element not found after retries');
        isInitializingRef.current = false;
        return;
      }

      const textareaElement = editorRef.current;
      const parentElement = textareaElement.parentElement;
      
      if (!parentElement) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element has no parent after retries');
        isInitializingRef.current = false;
        return;
      }

      // 确保元素在文档中
      if (!document.body.contains(textareaElement)) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element not in document after retries');
        isInitializingRef.current = false;
        return;
      }

      const $textarea = $(textareaElement);
      
      // 如果是卡片，使用markdown编辑器；如果是节点，使用普通文本编辑器
      if (selectedFile.type === 'card') {
        $textarea.attr('data-markdown', 'true');
      } else {
        $textarea.removeAttr('data-markdown');
      }

      // 确保使用最新的fileContent
      $textarea.val(fileContent);
      
      // 再次确认父元素存在（因为 initMarkdownEditor 是异步的）
      if (!textareaElement.parentElement) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Textarea has no parent element after retries');
        isInitializingRef.current = false;
        return;
      }
      
      try {
        currentEditor = new Editor($textarea, {
          value: fileContent,
          language: selectedFile.type === 'card' ? undefined : 'plain',
          onChange: (value: string) => {
            // 如果正在初始化，忽略onChange（避免在初始化时触发）
            if (isInitializingRef.current) {
              return;
            }
            setFileContent(value);
            
            // 立即将修改添加到pendingChanges
            const currentSelectedFile = selectedFileRef.current;
            if (currentSelectedFile) {
              const originalContent = originalContentsRef.current.get(currentSelectedFile.id) || '';
              
              // 如果内容有变化，立即添加到待提交列表
              if (value !== originalContent) {
                setPendingChanges(prev => {
                  const newMap = new Map(prev);
                  newMap.set(currentSelectedFile.id, {
                    file: currentSelectedFile,
                    content: value,
                    originalContent: originalContent,
                  });
                  return newMap;
                });
              } else {
                // 如果内容恢复原样，从pendingChanges中移除
                setPendingChanges(prev => {
                  const newMap = new Map(prev);
                  if (newMap.has(currentSelectedFile.id)) {
                    newMap.delete(currentSelectedFile.id);
                  }
                  return newMap;
                });
              }
            }
          },
        });

        // 等待一小段时间，确保 Editor 的异步初始化开始
        // 如果初始化失败，会在控制台显示错误，但不会崩溃
        setTimeout(() => {
          setEditorInstance(currentEditor);
          isInitializingRef.current = false;
        }, 100);
      } catch (error) {
        console.error('Failed to initialize editor:', error);
        isInitializingRef.current = false;
      }
    };

    // 延迟初始化，确保DOM已更新，并且fileContent已经设置
    const timer = setTimeout(() => {
      requestAnimationFrame(initEditor);
    }, 200);

    return () => {
      clearTimeout(timer);
      if (currentEditor) {
        try {
          currentEditor.destroy();
        } catch (error) {
          console.warn('Error destroying editor in cleanup:', error);
        }
      }
      isInitializingRef.current = false;
    };
  }, [selectedFile?.id]);
  
  // 监听 fileContent 变化，更新编辑器内容（当编辑器已初始化且文件未变化时）
  useEffect(() => {
    if (!editorInstance || !selectedFile || isInitializingRef.current) {
      return;
    }
    
    // 只有当文件ID没有变化时，才更新编辑器内容
    if (selectedFileIdRef.current === selectedFile.id) {
      try {
        const currentValue = editorInstance.value();
        if (currentValue !== fileContent) {
          editorInstance.value(fileContent);
        }
      } catch (e) {
        // 如果编辑器还没有完全初始化，忽略错误
        console.warn('Failed to update editor content:', e);
      }
    }
  }, [fileContent, editorInstance, selectedFile]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      // 清理工作
    };
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', backgroundColor: '#fff' }}>
      {/* 左侧文件树 */}
      <div style={{
        width: '250px',
        borderRight: '1px solid #e1e4e8',
        backgroundColor: '#f6f8fa',
        overflow: 'auto',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e1e4e8',
          fontSize: '12px',
          fontWeight: '600',
          color: '#586069',
          backgroundColor: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>EXPLORER</span>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {explorerMode === 'tree' && (
              <>
                <button
                  onClick={() => {
                    setIsMultiSelectMode(!isMultiSelectMode);
                    if (isMultiSelectMode) {
                      setSelectedItems(new Set());
                    }
                  }}
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    border: '1px solid #d1d5da',
                    borderRadius: '3px',
                    backgroundColor: isMultiSelectMode ? '#0366d6' : '#fff',
                    color: isMultiSelectMode ? '#fff' : '#586069',
                    cursor: 'pointer',
                  }}
                  title={isMultiSelectMode ? '退出多选模式' : '多选模式'}
                >
                  {isMultiSelectMode ? '✓' : '☐'}
                </button>
              </>
            )}
            <button
              onClick={() => setExplorerMode('tree')}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: explorerMode === 'tree' ? '#0366d6' : '#fff',
                color: explorerMode === 'tree' ? '#fff' : '#586069',
                cursor: 'pointer',
              }}
              title="树形视图"
            >
              树形
            </button>
            <button
              onClick={() => setExplorerMode('files')}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: explorerMode === 'files' ? '#0366d6' : '#fff',
                color: explorerMode === 'files' ? '#fff' : '#586069',
                cursor: 'pointer',
              }}
              title="文件视图"
            >
              文件
            </button>
            <button
              onClick={() => setExplorerMode('pending')}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: explorerMode === 'pending' ? '#0366d6' : '#fff',
                color: explorerMode === 'pending' ? '#fff' : '#586069',
                cursor: 'pointer',
              }}
              title="查看待提交的更改"
            >
              修改
            </button>
          </div>
        </div>
        <div style={{ padding: '8px 0' }}>
          {explorerMode === 'tree' ? (
            fileTree.map((file) => {
            const isSelected = isMultiSelectMode ? selectedItems.has(file.id) : (selectedFile?.id === file.id);
            const isDragOver = dragOverFile?.id === file.id;
            const isDragged = draggedFile?.id === file.id;
            const isEditing = editingFile?.id === file.id;
            const isExpanded = file.type === 'node' && expandedNodes.has(file.nodeId || '');
            
            return (
              <div
                key={file.id}
                draggable={true}
                onDragStart={(e) => handleDragStart(e, file)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, file)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => {
                  handleDrop(e, file);
                  // 确保清除拖动状态
                  if (dragLeaveTimeoutRef.current) {
                    clearTimeout(dragLeaveTimeoutRef.current);
                    dragLeaveTimeoutRef.current = null;
                  }
                  if (dragOverTimeoutRef.current) {
                    clearTimeout(dragOverTimeoutRef.current);
                    dragOverTimeoutRef.current = null;
                  }
                  setDragOverFile(null);
                  setDropPosition('after');
                  lastDragOverFileRef.current = null;
                  lastDropPositionRef.current = 'after';
                }}
                onClick={(e) => {
                  if (isEditing) return;
                  // 如果点击的是节点，且点击的不是展开/折叠按钮，则选择文件
                  if (file.type === 'node') {
                    const target = e.target as HTMLElement;
                    // 如果点击的是展开/折叠按钮，不选择文件
                    if (target.style.cursor === 'pointer' && (target.textContent === '▼' || target.textContent === '▶')) {
                      return;
                    }
                  }
                  handleSelectFile(file);
                }}
                onDoubleClick={(e) => handleStartRename(file, e)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, file });
                }}
                style={{
                  padding: `4px ${8 + file.level * 16}px`,
                  cursor: isEditing ? 'text' : 'pointer',
                  fontSize: '13px',
                  color: isSelected ? '#fff' : '#24292e',
                  backgroundColor: isSelected 
                    ? '#0366d6' 
                    : isDragOver 
                      ? '#e3f2fd' 
                      : isDragged
                        ? '#f0f0f0'
                        : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  opacity: isDragged ? 0.5 : 1,
                  border: isDragOver 
                    ? dropPosition === 'into'
                      ? '2px dashed #2196F3' 
                      : '2px solid #2196F3'
                    : file.clipboardType === 'cut'
                      ? '2px dashed #f44336' // 被剪切的用红色虚线
                      : file.clipboardType === 'copy'
                        ? '2px dashed #4caf50' // 被复制的用绿色虚线
                        : file.hasPendingChanges
                          ? '1px dashed #ff9800' // 未保存的更改用橙色虚线
                          : '2px solid transparent',
                  borderTop: isDragOver && dropPosition === 'before' 
                    ? '3px solid #1976D2' 
                    : undefined,
                  borderBottom: isDragOver && dropPosition === 'after' 
                    ? '3px solid #1976D2' 
                    : undefined,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected && !isDragOver && !isDragged) {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected && !isDragOver && !isDragged) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
              {isMultiSelectMode && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggleSelect(file)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginRight: '6px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                />
              )}
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
                      userSelect: 'none',
                      marginRight: '2px',
                    }}
                    title={isExpanded ? '折叠' : '展开'}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </span>
                  <span style={{ 
                    fontSize: '16px', 
                    flexShrink: 0,
                    width: '16px',
                    height: '16px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {isExpanded ? '📁' : '📂'}
                  </span>
                </>
              ) : (
                <span style={{ 
                  fontSize: '14px', 
                  flexShrink: 0,
                  width: '16px',
                  height: '16px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginLeft: '18px', // 对齐文件夹图标（16px 展开按钮 + 2px margin）
                }}>
                  📄
                </span>
              )}
              {isEditing ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={async () => {
                    // 失去焦点时保存更改
                    if (editingFile && editingName.trim() && editingName !== editingFile.name) {
                      await handleConfirmRename();
                    } else {
                      handleCancelRename();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur(); // 触发 onBlur，从而保存
                    } else if (e.key === 'Escape') {
                      handleCancelRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  style={{
                    flex: 1,
                    padding: '2px 4px',
                    fontSize: '13px',
                    border: '1px solid #0366d6',
                    borderRadius: '3px',
                    outline: 'none',
                  }}
                />
              ) : (
                <span style={{ 
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  {file.name}
                  {file.clipboardType === 'cut' && (
                    <span style={{ 
                      fontSize: '10px', 
                      color: '#f44336',
                      fontWeight: 'bold',
                    }} title="已剪切">
                      ✂
                    </span>
                  )}
                  {file.clipboardType === 'copy' && (
                    <span style={{ 
                      fontSize: '10px', 
                      color: '#4caf50',
                      fontWeight: 'bold',
                    }} title="已复制">
                      📋
                    </span>
                  )}
                </span>
              )}
            </div>
            );
          })
          ) : explorerMode === 'files' ? (
            // 文件模式
            <div style={{ padding: '8px' }}>
              {/* 跳转到文件管理页面的按钮 */}
              <div style={{ marginBottom: '8px' }}>
                <button
                  onClick={() => {
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    const branch = mindMap.currentBranch || 'main';
                    const filesUrl = docId 
                      ? `/d/${domainId}/mindmap/${docId}/files${branch ? `?branch=${branch}` : ''}`
                      : `/d/${domainId}/mindmap/mmid/${mindMap.mmid}/files${branch ? `?branch=${branch}` : ''}`;
                    window.open(filesUrl, '_blank');
                  }}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '12px',
                    border: '1px solid #d1d5da',
                    borderRadius: '3px',
                    backgroundColor: '#fff',
                    color: '#586069',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#fff';
                  }}
                >
                  <span>📁</span>
                  <span>管理文件</span>
                </button>
              </div>
              
              {/* 文件列表 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {files.length === 0 ? (
                  <div style={{
                    padding: '20px',
                    textAlign: 'center',
                    color: '#999',
                    fontSize: '12px',
                  }}>
                    暂无文件
                  </div>
                ) : (
                  files.map((file) => (
                    <div
                      key={file._id}
                      onClick={() => {
                        const domainId = (window as any).UiContext?.domainId || 'system';
                        const branch = mindMap.currentBranch || 'main';
                        let url = docId 
                          ? `/d/${domainId}/mindmap/${docId}/file/${encodeURIComponent(file.name)}`
                          : `/d/${domainId}/mindmap/mmid/${mindMap.mmid}/file/${encodeURIComponent(file.name)}`;
                        // 添加 noDisposition=1 参数以启用预览
                        url = url.includes('?') ? `${url}&noDisposition=1` : `${url}?noDisposition=1`;
                        window.open(url, '_blank');
                        setSelectedFileForPreview(file.name);
                      }}
                      style={{
                        padding: '6px 8px',
                        fontSize: '12px',
                        color: selectedFileForPreview === file.name ? '#fff' : '#24292e',
                        backgroundColor: selectedFileForPreview === file.name ? '#0366d6' : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        borderRadius: '3px',
                      }}
                      onMouseEnter={(e) => {
                        if (selectedFileForPreview !== file.name) {
                          e.currentTarget.style.backgroundColor = '#f3f4f6';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (selectedFileForPreview !== file.name) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }
                      }}
                    >
                      <span style={{ fontSize: '14px' }}>📄</span>
                      <span style={{ 
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {file.name}
                      </span>
                      <span style={{ 
                        fontSize: '11px',
                        color: selectedFileForPreview === file.name ? 'rgba(255,255,255,0.8)' : '#999',
                      }}>
                        {(file.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            // 待提交模式
            <div style={{ padding: '8px' }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '600',
                color: '#586069',
                marginBottom: '12px',
                padding: '0 8px',
              }}>
                待提交的更改
              </div>
              <div style={{
                fontSize: '11px',
                color: '#586069',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '0 8px',
              }}>
                {/* 内容更改 */}
                {pendingChanges.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>内容更改 ({pendingChanges.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingChanges.values()).slice(0, 5).map((change, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {change.file.name}
                        </div>
                      ))}
                      {pendingChanges.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingChanges.size - 5} 个</div>
          )}
        </div>
      </div>
                )}
                
                {/* 拖动更改 */}
                {pendingDragChanges.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>拖动更改 ({pendingDragChanges.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDragChanges).slice(0, 5).map((item, idx) => {
                        const file = fileTree.find(f => 
                          (f.type === 'node' && f.nodeId === item.replace('node-', '')) ||
                          (f.type === 'card' && f.cardId === item)
                        );
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : item}
                          </div>
                        );
                      })}
                      {pendingDragChanges.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDragChanges.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* 重命名更改 */}
                {pendingRenames.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>重命名 ({pendingRenames.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingRenames.values()).slice(0, 5).map((rename, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {rename.file.name} → {rename.newName}
                        </div>
                      ))}
                      {pendingRenames.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingRenames.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* 新建项目 */}
                {pendingCreatesCount > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>新建 ({pendingCreatesCount})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingCreatesRef.current.values()).slice(0, 5).map((create, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {create.type === 'card' ? '卡片' : '节点'}: {create.title || create.text || '未命名'}
                        </div>
                      ))}
                      {pendingCreatesCount > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingCreatesCount - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* 删除项目 */}
                {pendingDeletes.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>删除 ({pendingDeletes.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDeletes.values()).slice(0, 5).map((del, idx) => {
                        const file = fileTree.find(f => 
                          (del.type === 'node' && f.type === 'node' && f.nodeId === del.id) ||
                          (del.type === 'card' && f.type === 'card' && f.cardId === del.id)
                        );
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : `${del.type === 'card' ? '卡片' : '节点'} (${del.id.substring(0, 8)}...)`}
                          </div>
                        );
                      })}
                      {pendingDeletes.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDeletes.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* 如果没有待提交内容 */}
                {pendingChanges.size === 0 && 
                 pendingDragChanges.size === 0 && 
                 pendingRenames.size === 0 && 
                 pendingCreatesCount === 0 && 
                 pendingDeletes.size === 0 && (
                  <div style={{ 
                    color: '#999', 
                    fontStyle: 'italic',
                    textAlign: 'center',
                    padding: '8px 0',
                  }}>
                    暂无待提交的更改
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>


      {/* 右键菜单 */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            zIndex: 1000,
            minWidth: '180px',
            padding: '4px 0',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.file.type === 'node' ? (
            <>
              {/* 粘贴选项（仅在剪贴板有内容时显示） */}
              {clipboard && (
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
                    onClick={() => handlePaste(contextMenu.file.nodeId || '')}
                  >
                    粘贴{clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}
                  </div>
                  <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
                </>
              )}
              {/* 多选模式的复制、剪切和删除 */}
              {isMultiSelectMode && selectedItems.size > 0 && (
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
                    onClick={() => handleCopy()}
                  >
                    复制选中项 ({selectedItems.size})
                  </div>
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
                    onClick={() => handleCut()}
                  >
                    剪切选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: '#d73a49',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      handleBatchDelete();
                      setContextMenu(null);
                    }}
                  >
                    删除选中项 ({selectedItems.size})
                  </div>
                  <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
                </>
              )}
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
                onClick={() => handleNewCard(contextMenu.file.nodeId || '')}
              >
                新建 Card
              </div>
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
                onClick={() => handleNewChildNode(contextMenu.file.nodeId || '')}
              >
                新建子 Node
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
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
                  setSortWindow({ nodeId: contextMenu.file.nodeId || '' });
                  setContextMenu(null);
                }}
              >
                排序
              </div>
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
                  handleExportToPDF(contextMenu.file.nodeId || '');
                }}
              >
                导出为PDF
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
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
                onClick={() => handleCopy(contextMenu.file)}
              >
                复制
              </div>
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
                onClick={() => handleCut(contextMenu.file)}
              >
                剪切
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#d73a49',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleDelete(contextMenu.file)}
              >
                删除 Node
              </div>
            </>
          ) : (
            <>
              {/* 多选模式的复制、剪切和删除 */}
              {isMultiSelectMode && selectedItems.size > 0 && (
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
                    onClick={() => handleCopy()}
                  >
                    复制选中项 ({selectedItems.size})
                  </div>
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
                    onClick={() => handleCut()}
                  >
                    剪切选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: '#d73a49',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      handleBatchDelete();
                      setContextMenu(null);
                    }}
                  >
                    删除选中项 ({selectedItems.size})
                  </div>
                  <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
                </>
              )}
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
                onClick={() => handleCopy(contextMenu.file)}
              >
                复制
              </div>
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
                onClick={() => handleCut(contextMenu.file)}
              >
                剪切
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#d73a49',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleDelete(contextMenu.file)}
              >
                删除 Card
              </div>
            </>
          )}
        </div>
      )}

      {/* 点击外部关闭右键菜单 */}
      {contextMenu && (
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
        />
      )}

      {/* 排序窗口 */}
      {sortWindow && (
        <SortWindow
          nodeId={sortWindow.nodeId}
          mindMap={mindMap}
          docId={docId}
          getMindMapUrl={getMindMapUrl}
          onClose={() => setSortWindow(null)}
          nodeCardsMapVersion={nodeCardsMapVersion}
          onSave={async (sortedItems) => {
            try {
              const domainId = (window as any).UiContext?.domainId || 'system';
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              
              // 更新node的order和card的order
              const updatePromises = [];
              
              // 更新mindMap中的nodes的order（包括临时节点）
              const updatedNodes = mindMap.nodes.map(node => {
                const sortedItem = sortedItems.find(item => item.type === 'node' && item.id === node.id);
                if (sortedItem && node.order !== sortedItem.order) {
                  return { ...node, order: sortedItem.order };
                }
                return node;
              });
              
              // 更新mindMap状态（包含更新后的nodes）
              setMindMap(prev => ({
                ...prev,
                nodes: updatedNodes,
              }));
              
              // 批量更新card的order
              for (const sortedItem of sortedItems) {
                if (sortedItem.type === 'card') {
                  const card = (nodeCardsMap[sortWindow.nodeId] || []).find((c: Card) => c.docId === sortedItem.id);
                  if (card && card.order !== sortedItem.order) {
                    // 如果是临时卡片，只更新前端状态，不调用后端API
                    if (sortedItem.id.startsWith('temp-card-')) {
                      card.order = sortedItem.order;
                    } else {
                      // 已存在的卡片，调用后端API更新
                      updatePromises.push(
                        request.post(`/d/${domainId}/mindmap/card/${sortedItem.id}`, {
                          operation: 'update',
                          nodeId: sortWindow.nodeId,
                          order: sortedItem.order,
                        }).then(() => {
                          card.order = sortedItem.order;
                        }).catch((error: any) => {
                          console.error(`Failed to update card ${sortedItem.id} order:`, error);
                          throw new Error(`更新卡片「${card.title || sortedItem.id}」顺序失败: ${error?.message || '未知错误'}`);
                        })
                      );
                    }
                  }
                }
              }
              
              // 等待所有更新完成
              if (updatePromises.length > 0) {
                await Promise.all(updatePromises);
              }
              
              // 更新nodeCardsMap并排序
              if (nodeCardsMap[sortWindow.nodeId]) {
                nodeCardsMap[sortWindow.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
                (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              }
              
              // 触发重新渲染
              setNodeCardsMapVersion(prev => prev + 1);
              
              // 保存mindMap以持久化node的order字段
              try {
                // 过滤掉临时节点和边，确保不会保存临时数据
                const sortedNodes = updatedNodes.filter(n => !n.id.startsWith('temp-node-'));
                const sortedEdges = mindMap.edges.filter(e => 
                  !e.source.startsWith('temp-node-') && 
                  !e.target.startsWith('temp-node-') &&
                  !e.id.startsWith('temp-edge-')
                );
                
                await request.post(getMindMapUrl('/save', docId), {
                  nodes: sortedNodes,
                  edges: sortedEdges,
                  operationDescription: '排序更新',
                });
              } catch (error: any) {
                console.warn('Failed to save mindMap after sort:', error);
                // 不阻止排序保存，只是警告
              }
              
              // 记录更改，以便在保存时一起保存
              setPendingDragChanges(prev => {
                const newSet = new Set(prev);
                sortedItems.forEach(item => {
                  if (item.type === 'node') {
                    newSet.add(`node-${item.id}`);
                  } else {
                    newSet.add(`card-${item.id}`);
                  }
                });
                return newSet;
              });
              
              Notification.success('排序已保存');
              setSortWindow(null);
            } catch (error: any) {
              console.error('Failed to save sort order:', error);
              Notification.error(`保存排序失败: ${error?.message || '未知错误'}`);
            }
          }}
        />
      )}

      {/* 中间编辑器区域 */}
      <div style={{ 
        flex: 1, 
        display: 'flex', 
        flexDirection: 'column', 
        overflow: 'hidden',
        width: showAIChat ? `${100 - chatPanelWidth}%` : '100%',
        transition: isResizing ? 'none' : 'width 0.3s ease',
      }}>
        {/* 顶部工具栏 */}
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid #e1e4e8',
          backgroundColor: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <a
              href={(() => {
                const domainId = (window as any).UiContext?.domainId || 'system';
                const branch = mindMap.currentBranch || 'main';
                return `/d/${domainId}/mindmap/${docId}/branch/${branch}`;
              })()}
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                color: '#586069',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              ← 返回
            </a>
            {selectedFile && (
              <div style={{ fontSize: '13px', color: '#586069' }}>
                {selectedFile.name}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {(pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0) && (
              <span style={{ fontSize: '12px', color: '#586069' }}>
                {pendingChanges.size > 0 && `${pendingChanges.size} 个文件已修改`}
                {pendingChanges.size > 0 && (pendingDragChanges.size > 0 || pendingRenames.size > 0) && '，'}
                {pendingDragChanges.size > 0 && `${pendingDragChanges.size} 个拖动操作`}
                {pendingDragChanges.size > 0 && pendingRenames.size > 0 && '，'}
                {pendingRenames.size > 0 && `${pendingRenames.size} 个重命名`}
              </span>
            )}
            <button
              onClick={() => setShowAIChat(!showAIChat)}
              style={{
                padding: '4px 12px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: showAIChat ? '#2196f3' : '#fff',
                color: showAIChat ? '#fff' : '#333',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: '500',
              }}
            >
              {showAIChat ? '隐藏 AI' : '显示 AI'}
            </button>
            <button
              onClick={handleSaveAll}
              disabled={isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0)}
              style={{
                padding: '4px 12px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: (pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0 || pendingCreatesCount > 0 || pendingDeletes.size > 0) ? '#28a745' : '#6c757d',
                color: '#fff',
                cursor: (isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0)) ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: '500',
                opacity: (isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0)) ? 0.6 : 1,
              }}
              title={(pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0) ? '没有待保存的更改' : '保存所有更改'}
            >
              {isCommitting ? '保存中...' : `保存更改 (${pendingChanges.size + pendingDragChanges.size + pendingRenames.size + pendingCreatesCount + pendingDeletes.size})`}
            </button>
          </div>
        </div>

        {/* 编辑器内容 + 题目区域 */}
        <div 
          id="editor-container"
          style={{ flex: 1, padding: '0', overflow: 'hidden', position: 'relative', backgroundColor: '#fff', display: 'flex', flexDirection: 'column' }}
        >
          {/* Markdown 编辑器 */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {selectedFile && selectedFile.type === 'card' ? (
              <div 
                id={`editor-wrapper-${selectedFile.id}`}
                style={{ width: '100%', height: '100%', position: 'relative' }}
              >
                <textarea
                  key={selectedFile.id}
                  ref={editorRef}
                  defaultValue={fileContent}
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    outline: 'none',
                    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, "source-code-pro", monospace',
                    fontSize: '14px',
                    lineHeight: '1.6',
                    resize: 'none',
                    padding: '16px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            ) : (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#586069',
                fontSize: '14px',
              }}>
                {selectedFile?.type === 'node' ? '节点不支持编辑，请在 EXPLORER 中重命名' : '请从左侧选择一个卡片'}
              </div>
            )}
          </div>

          {/* 当前卡片的本地单选题区域 */}
          {selectedFile && selectedFile.type === 'card' && (
            <div
              style={{
                borderTop: '1px solid #e1e4e8',
                padding: '8px 12px',
                background: '#fafbfc',
                maxHeight: '260px',
                overflowY: 'auto',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '13px', color: '#24292e' }}>本卡片的练习题</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '12px', color: '#6a737d' }}>支持本地单选题</span>
                  <button
                    onClick={() => setShowProblemForm(true)}
                    style={{
                      padding: '2px 8px',
                      fontSize: '12px',
                      borderRadius: '3px',
                      border: '1px solid #0366d6',
                      background: '#0366d6',
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    新建题目
                  </button>
                </div>
              </div>

              {/* 已有题目列表 */}
              {(() => {
                const card = getSelectedCard();
                const problems = card?.problems || [];
                if (!problems.length) {
                  return (
                    <div style={{ fontSize: '12px', color: '#6a737d', marginBottom: '8px' }}>
                      还没有为本卡片创建题目，可以点击右上角「新建题目」按钮来添加。
                    </div>
                  );
                }
                return (
                  <div style={{ marginBottom: '8px' }}>
                    {problems.map((p, index) => (
                      <div
                        key={p.pid}
                        style={{
                          border: '1px solid #e1e4e8',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          marginBottom: '6px',
                          background: '#fff',
                        }}
                      >
                        <div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
                          Q{index + 1}（单选）：{p.stem}
                        </div>
                        <ul style={{ paddingLeft: '20px', margin: 0, fontSize: '12px' }}>
                          {p.options.map((opt, oi) => (
                            <li
                              key={oi}
                              style={{
                                color: oi === p.answer ? '#22863a' : '#24292e',
                                fontWeight: oi === p.answer ? 600 : 400,
                              }}
                            >
                              {String.fromCharCode(65 + oi)}. {opt}
                              {oi === p.answer && <span style={{ marginLeft: 4 }}>(正确)</span>}
                            </li>
                          ))}
                        </ul>
                        {p.analysis && (
                          <div style={{ marginTop: '4px', fontSize: '12px', color: '#6a737d' }}>
                            解析：{p.analysis}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* 新建单选题表单（默认收起，点击“新建题目”后显示） */}
              {showProblemForm && (
                <div
                  style={{
                    borderTop: '1px dashed #e1e4e8',
                    paddingTop: '8px',
                    marginTop: '4px',
                  }}
                >
                  <div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>生成新的单选题</div>
                  <div style={{ marginBottom: '4px' }}>
                    <textarea
                      value={problemStem}
                      onChange={e => setProblemStem(e.target.value)}
                      placeholder="题干（例如：这段卡片主要讲了什么？）"
                      style={{
                        width: '100%',
                        minHeight: '40px',
                        resize: 'vertical',
                        fontSize: '12px',
                        padding: '4px 6px',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '4px' }}>
                    {problemOptions.map((opt, index) => (
                      <input
                        key={index}
                        value={opt}
                        onChange={e => {
                          const next = [...problemOptions];
                          next[index] = e.target.value;
                          setProblemOptions(next);
                        }}
                        placeholder={`选项 ${String.fromCharCode(65 + index)}`}
                        style={{
                          fontSize: '12px',
                          padding: '3px 6px',
                          boxSizing: 'border-box',
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', fontSize: '12px' }}>
                    <span style={{ marginRight: 4 }}>正确答案：</span>
                    {problemOptions.map((_, index) => (
                      <label key={index} style={{ marginRight: 6, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="problem-answer"
                          checked={problemAnswer === index}
                          onChange={() => setProblemAnswer(index)}
                          style={{ marginRight: 2 }}
                        />
                        {String.fromCharCode(65 + index)}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginBottom: '4px' }}>
                    <textarea
                      value={problemAnalysis}
                      onChange={e => setProblemAnalysis(e.target.value)}
                      placeholder="解析（可选）"
                      style={{
                        width: '100%',
                        minHeight: '32px',
                        resize: 'vertical',
                        fontSize: '12px',
                        padding: '4px 6px',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      onClick={() => {
                        setShowProblemForm(false);
                        setProblemStem('');
                        setProblemOptions(['', '', '', '']);
                        setProblemAnswer(0);
                        setProblemAnalysis('');
                      }}
                      disabled={isSavingProblem}
                      style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: '1px solid #d1d5da',
                        background: '#fff',
                        color: '#24292e',
                        fontSize: '12px',
                        cursor: isSavingProblem ? 'not-allowed' : 'pointer',
                      }}
                    >
                      取消
                    </button>
                    <button
                      onClick={handleCreateSingleProblem}
                      disabled={isSavingProblem}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '4px',
                        border: '1px solid #0366d6',
                        background: isSavingProblem ? '#c0dfff' : '#0366d6',
                        color: '#fff',
                        fontSize: '12px',
                        cursor: isSavingProblem ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isSavingProblem ? '生成中...' : '生成单选题'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 分隔条 */}
      {showAIChat && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizing(true);
            resizeStartXRef.current = e.clientX;
            resizeStartWidthRef.current = chatPanelWidth;
          }}
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

      {/* AI 聊天侧边栏 */}
      {showAIChat && (
        <div style={{
          width: `${chatPanelWidth}px`,
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
              onClick={() => setShowAIChat(false)}
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
                <p>你好！我是 AI 助手，可以帮助你操作思维导图。</p>
                <p style={{ marginTop: '8px', fontSize: '12px' }}>例如：</p>
                <ul style={{ textAlign: 'left', marginTop: '8px', fontSize: '12px', color: '#666' }}>
                  <li>"在根节点下创建一个名为 '新节点' 的节点"</li>
                  <li>"在 '节点名' 下创建一个卡片，标题为 '新卡片'"</li>
                  <li>"将 '节点A' 移动到 '节点B' 下"</li>
                  <li>"将 '节点A' 重命名为 '新名称'"</li>
                  <li>"删除 '节点A'"</li>
                </ul>
              </div>
            )}
            {chatMessages.map((msg, index) => {
              if (msg.role === 'operation') {
                // 操作气泡
                return (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div
                      onClick={() => {
                        setChatMessages(prev => {
                          const newMessages = [...prev];
                          newMessages[index] = {
                            ...newMessages[index],
                            isExpanded: !newMessages[index].isExpanded,
                          };
                          return newMessages;
                        });
                      }}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        background: '#e3f2fd',
                        border: '1px solid #90caf9',
                        color: '#1976d2',
                        maxWidth: '85%',
                        fontSize: '14px',
                        cursor: 'pointer',
                        userSelect: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      <span style={{ fontSize: '16px' }}>⚙️</span>
                      <span>{msg.content}</span>
                      <span style={{ fontSize: '12px', opacity: 0.7 }}>
                        {msg.isExpanded ? '▼' : '▶'}
                      </span>
                    </div>
                    {msg.isExpanded && msg.operations && (
                      <div style={{
                        marginTop: '8px',
                        padding: '12px',
                        background: '#f5f5f5',
                        borderRadius: '8px',
                        maxWidth: '85%',
                        fontSize: '12px',
                        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
                        overflowX: 'auto',
                      }}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {JSON.stringify({ operations: msg.operations }, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              }
              
              // 普通消息
              return (
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
                    {msg.role === 'user' && msg.references && msg.references.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                        {msg.references.map((ref, refIndex) => (
                          <div
                            key={refIndex}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 8px',
                              background: 'rgba(255, 255, 255, 0.2)',
                              borderRadius: '4px',
                              fontSize: '12px',
                            }}
                          >
                            <span style={{ fontSize: '12px' }}>
                              {ref.type === 'node' ? '📂' : '📄'}
                            </span>
                            <span style={{ fontWeight: '500' }}>{ref.name}</span>
                            <span style={{ opacity: 0.8, fontSize: '11px' }}>
                              {ref.path.join(' > ')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.content}
                  </div>
                </div>
              );
            })}
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
            {/* 显示引用标签 */}
            {chatInputReferences.length > 0 && (
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                marginBottom: '8px',
                padding: '6px',
                background: '#fff',
                borderRadius: '4px',
                border: '1px solid #ddd',
                minHeight: '32px',
              }}>
                {chatInputReferences.map((ref, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 8px',
                      background: '#e3f2fd',
                      borderRadius: '4px',
                      fontSize: '12px',
                      border: '1px solid #90caf9',
                    }}
                  >
                    <span style={{ fontSize: '12px' }}>
                      {ref.type === 'node' ? '📂' : '📄'}
                    </span>
                    <span style={{ fontWeight: '500', color: '#1976d2' }}>{ref.name}</span>
                    <span style={{ opacity: 0.7, fontSize: '11px', color: '#1976d2' }}>
                      {ref.path.join(' > ')}
                    </span>
                    <button
                      onClick={() => {
                        // 移除引用
                        const placeholder = `@${ref.name}`;
                        const startIndex = ref.startIndex;
                        const endIndex = ref.endIndex;
                        
                        // 从文本中移除占位符
                        const newText = chatInput.slice(0, startIndex) + chatInput.slice(endIndex);
                        
                        // 更新引用列表
                        setChatInputReferences(prev => {
                          const newRefs = prev
                            .filter((_, i) => i !== index)
                            .map(r => {
                              // 调整后续引用的位置
                              if (r.startIndex > startIndex) {
                                return {
                                  ...r,
                                  startIndex: r.startIndex - placeholder.length,
                                  endIndex: r.endIndex - placeholder.length,
                                };
                              }
                              return r;
                            });
                          return newRefs;
                        });
                        
                        setChatInput(newText);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '0',
                        marginLeft: '4px',
                        fontSize: '14px',
                        color: '#1976d2',
                        lineHeight: '1',
                      }}
                      title="移除引用"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={chatInput}
              onChange={(e) => {
                const newText = e.target.value;
                const oldText = chatInput;
                
                // 更新引用位置
                if (newText.length !== oldText.length) {
                  const diff = newText.length - oldText.length;
                  const selectionStart = e.currentTarget.selectionStart;
                  
                  setChatInputReferences(prev => {
                    return prev.map(ref => {
                      // 如果插入/删除在引用之前，调整引用位置
                      if (selectionStart <= ref.startIndex) {
                        return {
                          ...ref,
                          startIndex: ref.startIndex + diff,
                          endIndex: ref.endIndex + diff,
                        };
                      }
                      // 如果插入/删除在引用内部，可能需要移除引用
                      else if (selectionStart > ref.startIndex && selectionStart < ref.endIndex) {
                        // 如果引用被删除，返回 null，稍后过滤
                        return null as any;
                      }
                      return ref;
                    }).filter(ref => ref !== null && ref.startIndex >= 0 && ref.endIndex <= newText.length);
                  });
                }
                
                setChatInput(newText);
              }}
              onPaste={handleAIChatPaste}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAIChatSend();
                }
              }}
              placeholder="输入消息... (Shift+Enter换行，Enter发送，粘贴复制的节点/卡片会自动添加引用)"
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
              onClick={handleAIChatSend}
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
}

// 辅助函数：获取带 domainId 的 mindmap URL
const getMindMapUrl = (path: string, docId: string): string => {
  const domainId = (window as any).UiContext?.domainId || 'system';
  return `/d/${domainId}/mindmap/${docId}${path}`;
};

const page = new NamedPage('mindmap_editor', async () => {
  try {
    const $container = $('#mindmap-editor-mode');
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
      <MindMapEditorMode docId={docId} initialData={initialData} />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize mindmap editor mode:', error);
    Notification.error('初始化编辑器模式失败: ' + (error.message || '未知错误'));
  }
});

export default page;


import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import Editor from 'vj/components/editor';

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

function MindMapEditorMode({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  const [mindMap, setMindMap] = useState<MindMapDoc>(initialData);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [pendingRenames, setPendingRenames] = useState<Map<string, PendingRename>>(new Map());
  const [pendingCreates, setPendingCreates] = useState<Map<string, PendingCreate>>(new Map()); // 待创建的项目
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
  const [clipboard, setClipboard] = useState<{ type: 'copy' | 'cut'; item: FileItem } | null>(null); // 剪贴板
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
  const [explorerMode, setExplorerMode] = useState<'tree' | 'files'>('tree'); // 文件树模式或文件模式
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
  
  // 默认展开所有节点
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const initialExpanded = new Set<string>();
    // 在组件初始化时，展开所有节点
    if (initialData?.nodes) {
      initialData.nodes.forEach(node => {
        initialExpanded.add(node.id);
      });
    }
    return initialExpanded;
  }); // 记录展开的节点

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
      
      if (file.type === 'node') {
        if (clipboard.item.type === 'node' && clipboard.item.nodeId === file.nodeId) {
          return clipboard.type;
        }
      } else if (file.type === 'card') {
        if (clipboard.item.type === 'card' && clipboard.item.cardId === file.cardId) {
          return clipboard.type;
        }
      }
      
      return undefined;
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
          Array.from(pendingCreates.values()).some(c => {
            if (c.tempId === file.id) return true;
            // 对于 card，file.id 是 card-${cardId}，需要匹配
            if (file.type === 'card' && file.id === `card-${c.tempId}`) return true;
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

      // 如果节点展开，显示其卡片和子节点
      if (isExpanded) {
        // 获取该节点的卡片（按 order 排序）
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            // 检查卡片是否属于当前节点（如果 card.nodeId 存在，使用它；否则假设属于当前节点）
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        nodeCards.forEach((card: Card) => {
          // 跳过待删除的卡片
          if (deletedCardIds.has(card.docId)) return;
          
          const cardFileItem: FileItem = {
            type: 'card',
            id: `card-${card.docId}`,
            name: card.title || '未命名卡片',
            nodeId: card.nodeId || nodeId, // 使用 card.nodeId（如果存在）或当前 nodeId
            cardId: card.docId,
            parentId: card.nodeId || nodeId,
            level: level + 1,
          };
          cardFileItem.hasPendingChanges = checkPendingChanges(cardFileItem);
          cardFileItem.clipboardType = checkClipboard(cardFileItem);
          items.push(cardFileItem);
        });
        
        // 添加待创建的卡片（临时显示）
        // 只显示那些不在 nodeCardsMap 中的卡片（避免重复）
        const existingCardIds = new Set((nodeCardsMap[nodeId] || []).map((c: Card) => c.docId));
        Array.from(pendingCreates.values())
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

        // 递归处理子节点
        nodeData.children.forEach((childId) => {
          buildTree(childId, level + 1, nodeId);
        });
      }
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });

    return items;
  }, [mindMap.nodes, mindMap.edges, nodeCardsMapVersion, expandedNodes, pendingChanges, pendingRenames, pendingCreates, pendingDragChanges, pendingDeletes, clipboard]);

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

  // 选择文件
  const handleSelectFile = useCallback(async (file: FileItem) => {
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
        console.warn('Failed to save current file changes:', error);
      }
    }
    
    setSelectedFile(file);
    
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
  }, [mindMap.nodes, selectedFile, editorInstance, fileContent, pendingChanges]);

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
      console.error('Failed to create single problem:', error);
      Notification.error('生成单选题失败: ' + (error.message || '未知错误'));
    } finally {
      setIsSavingProblem(false);
    }
  }, [selectedFile, problemStem, problemOptions, problemAnswer, problemAnalysis]);

  // 保存所有更改
  const handleSaveAll = useCallback(async () => {
    if (isCommitting) return;

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
        console.warn('Failed to save current file changes:', error);
      }
    }

    const hasContentChanges = allChanges.size > 0;
    const hasDragChanges = pendingDragChanges.size > 0;
    const hasRenameChanges = pendingRenames.size > 0;
    const hasCreateChanges = pendingCreates.size > 0;
    const hasDeleteChanges = pendingDeletes.size > 0;
    const hasProblemChanges = pendingProblemCardIds.size > 0;

    // 允许即使没有更改也执行保存（用于刷新或验证）
    // if (!hasContentChanges && !hasDragChanges && !hasRenameChanges) {
    //   Notification.info('没有待保存的更改');
    //   return;
    // }

    setIsCommitting(true);
    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      // 保存内容更改（包括附带的题目）
      if (hasContentChanges) {
        const changes = Array.from(allChanges.values());
        
        // 批量保存所有内容更改
        for (const change of changes) {
          if (change.file.type === 'node') {
            // 保存节点文本（使用 /node/:nodeId 路径，与 mindmap_detail 保持一致）
            await request.post(getMindMapUrl(`/node/${change.file.nodeId}`, docId), {
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
            console.warn('Problem change: card not found in nodeCardsMap', problemCardId);
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
                      // 如果删除失败（edge 可能已经被删除），继续处理，不抛出错误
                      if (!deleteError.message?.includes('not found')) {
                        console.warn(`Failed to delete edge ${oldEdge.id}:`, deleteError.message);
                      }
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
                    // 如果创建失败（edge 可能已经存在），记录警告但继续，不抛出错误
                    if (addError.message?.includes('already exists')) {
                      console.warn('Edge already exists, skipping creation');
                    } else {
                      // 其他错误也忽略，避免阻塞保存流程
                      console.warn('Failed to create edge:', addError.message);
                    }
                  }
                }
              } catch (error: any) {
                console.error('Failed to update node edges:', error);
                // 如果获取失败，尝试直接创建新边（后端会处理重复）
                try {
                  await request.post(getMindMapUrl('/edge', docId), {
                    operation: 'add',
                    source: newEdge.source,
                    target: newEdge.target,
                  });
                } catch (err: any) {
                  // 如果 edge 已存在，忽略错误
                  if (err.message?.includes('already exists')) {
                    console.warn('Edge already exists, skipping creation');
                  } else {
                    console.error('Failed to create edge:', err);
                  }
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
            } else {
              console.warn(`Card ${cardId} not found in nodeCardsMap`);
            }
          }
        }
      }
      
      // 保存重命名更改
      if (hasRenameChanges) {
        const renames = Array.from(pendingRenames.values());
        
        for (const rename of renames) {
          if (rename.file.type === 'node') {
            // 保存节点重命名
            // 与 mindmap_detail.page.tsx 保持一致，使用 operation: 'update'
            await request.post(getMindMapUrl(`/node/${rename.file.nodeId}`, docId), {
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

      const hasCreateChanges = pendingCreates.size > 0;
      const hasDeleteChanges = pendingDeletes.size > 0;
      
      // 保存新建操作
      if (hasCreateChanges) {
        const creates = Array.from(pendingCreates.values());
        
        for (const create of creates) {
          if (create.type === 'card') {
            // 创建新卡片（携带本地内容和题目）
            const createNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            const createNodeId = create.nodeId;
            const createNodeCards: Card[] = createNodeCardsMap[createNodeId] || [];
            const tempCard = createNodeCards.find((c: Card) => c.docId === create.tempId);

            // 检查 allChanges 中是否有对应的 content 更改（优先使用）
            const contentChange = allChanges.get(`card-${create.tempId}`);
            const finalContent = contentChange?.content ?? tempCard?.content ?? '';
            
            // 检查 pendingRenames 中是否有对应的重命名（优先使用）
            const renameChange = pendingRenames.get(`card-${create.tempId}`);
            const finalTitle = renameChange?.newName ?? create.title ?? tempCard?.title ?? '新卡片';
            const finalProblems = tempCard?.problems;

            const response = await request.post(getMindMapUrl('/card', docId), {
              nodeId: create.nodeId,
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
                  nodeId: create.nodeId,
                  title: finalTitle,
                  content: finalContent,
                  problems: finalProblems,
                });
              } catch (e) {
                console.warn('Failed to sync new card title/content, but card was created:', e);
              }
            }
            
            // 更新 nodeCardsMap，将临时 ID 替换为真实 ID
            const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            if (createNodeCardsMap[create.nodeId]) {
              const cards = createNodeCardsMap[create.nodeId];
              const tempCardIndex = cards.findIndex((c: Card) => c.docId === create.tempId);
              if (tempCardIndex >= 0) {
                cards[tempCardIndex] = {
                  ...cards[tempCardIndex],
                  docId: newCardId,
                };
                (window as any).UiContext.nodeCardsMap = { ...createNodeCardsMap };
              }
            }
          } else if (create.type === 'node') {
            // 创建新子节点
            const response = await request.post(getMindMapUrl('/node', docId), {
              text: create.text || '新节点',
              parentId: create.nodeId,
            });
            
            const newNodeId = response.nodeId;
            const newEdgeId = response.edgeId;
            
            // 更新 mindMap，将临时 ID 替换为真实 ID
            setMindMap(prev => ({
              ...prev,
              nodes: prev.nodes.map(n => 
                n.id === create.tempId 
                  ? { ...n, id: newNodeId }
                  : n
              ),
              edges: prev.edges.map(e => 
                e.target === create.tempId
                  ? { ...e, id: newEdgeId || e.id, target: newNodeId }
                  : e
              ),
            }));
          }
        }
      }
      
      // 保存删除操作
      if (hasDeleteChanges) {
        const deletes = Array.from(pendingDeletes.values());
        
        for (const del of deletes) {
          if (del.type === 'card') {
            // 临时卡片（尚未真正创建），只需要在前端移除，不调用后端删除接口
            if (!del.id || String(del.id).startsWith('temp-card-')) {
              continue;
            }
            // 删除已存在的卡片
            await request.post(`/d/${domainId}/mindmap/card/${del.id}`, {
              operation: 'delete',
            });
          } else if (del.type === 'node') {
            // 删除节点（需要先删除所有相关的 edges）
            const nodeEdges = mindMap.edges.filter(
              e => e.source === del.id || e.target === del.id
            );
            
            for (const edge of nodeEdges) {
              await request.post(getMindMapUrl('/edge', docId), {
                operation: 'delete',
                edgeId: edge.id,
              });
            }
            
            // 删除节点
            await request.post(getMindMapUrl(`/node/${del.id}`, docId), {
              operation: 'delete',
            });
          }
        }
      }

      const totalChanges = (hasContentChanges ? allChanges.size : 0) 
        + (hasDragChanges ? pendingDragChanges.size : 0) 
        + (hasRenameChanges ? pendingRenames.size : 0)
        + (hasCreateChanges ? pendingCreates.size : 0)
        + (hasDeleteChanges ? pendingDeletes.size : 0);
      Notification.success(`已保存 ${totalChanges} 个更改`);
      
      // 如果有重命名更改，重新加载数据以确保同步
      if (hasRenameChanges) {
        try {
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
        } catch (error) {
          console.warn('Failed to reload mindmap data after rename:', error);
        }
      }
      
      // 清空待提交列表
      setPendingChanges(new Map());
      setPendingDragChanges(new Set());
      setPendingRenames(new Map());
      setPendingCreates(new Map());
      setPendingDeletes(new Map());
      setPendingCreates(new Map());
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
  }, [pendingChanges, pendingDragChanges, pendingRenames, pendingCreates, pendingDeletes, selectedFile, editorInstance, fileContent, docId, getMindMapUrl, mindMap.edges]);

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
    const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newCard: PendingCreate = {
      type: 'card',
      nodeId,
      title: '新卡片',
      tempId,
    };
    
    setPendingCreates(prev => {
      const next = new Map(prev);
      next.set(tempId, newCard);
      return next;
    });
    
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
  }, []);

  // 新建子节点（前端操作）
  const handleNewChildNode = useCallback((parentNodeId: string) => {
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newChildNode: PendingCreate = {
      type: 'node',
      nodeId: parentNodeId,
      text: '新节点',
      tempId,
    };
    
    setPendingCreates(prev => {
      const next = new Map(prev);
      next.set(tempId, newChildNode);
      return next;
    });
    
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
    setExpandedNodes(prev => new Set(prev).add(parentNodeId));
    
    setContextMenu(null);
  }, []);

  // 复制节点或卡片
  const handleCopy = useCallback((file: FileItem) => {
    setClipboard({ type: 'copy', item: file });
    
    // 同时将信息存储到系统剪贴板，以便在 AI 对话框中粘贴时识别
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const reference = file.type === 'node' 
        ? `ejunz://node/${file.nodeId}`
        : `ejunz://card/${file.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        // 如果写入失败，忽略错误（可能是权限问题）
      });
    }
    
    setContextMenu(null);
  }, []);

  // 剪切节点或卡片
  const handleCut = useCallback((file: FileItem) => {
    setClipboard({ type: 'cut', item: file });
    setContextMenu(null);
  }, []);

  // 粘贴节点或卡片
  const handlePaste = useCallback((targetNodeId: string) => {
    if (!clipboard) return;

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};

    if (clipboard.item.type === 'node') {
      const sourceNodeId = clipboard.item.nodeId || '';
      const sourceNode = mindMap.nodes.find(n => n.id === sourceNodeId);
      
      // 如果源节点不存在，可能是已经被删除或移动了
      if (!sourceNode) {
        // 如果是剪切操作，清空剪贴板
        if (clipboard.type === 'cut') {
          setClipboard(null);
        }
        return;
      }
      
      // 如果剪切的是临时节点（已经粘贴过的），需要先清理 pendingCreates 和 pendingDeletes
      if (clipboard.type === 'cut' && sourceNodeId.startsWith('temp-')) {
        // 清理 pendingCreates 中的旧记录
        setPendingCreates(prev => {
          const next = new Map(prev);
          next.delete(sourceNodeId);
          return next;
        });
        
        // 清理 pendingDeletes 中的旧记录（如果存在）
        setPendingDeletes(prev => {
          const next = new Map(prev);
          next.delete(sourceNodeId);
          return next;
        });
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
            setPendingCreates(prev => {
              const next = new Map(prev);
              if (!next.has(newCard.docId)) {
                next.set(newCard.docId, {
                  type: 'card',
                  nodeId: newNode.id,
                  title: newCard.title || '新卡片',
                  tempId: newCard.docId,
                });
              }
              return next;
            });
          });
        }
      });
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };

      // 如果是剪切，删除原节点
      if (clipboard.type === 'cut') {
        // 如果源节点是临时节点（已经粘贴过的），不需要添加到 pendingDeletes
        // 只需要从 mindMap 中删除即可
        if (sourceNodeId.startsWith('temp-')) {
          // 临时节点，直接删除，不需要标记为待删除
          setMindMap(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
          
          // 清理相关的卡片
          nodeIdMap.forEach((newId, oldId) => {
            if (nodeCardsMap[oldId]) {
              delete nodeCardsMap[oldId];
            }
          });
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
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
          setPendingCreates(prev => {
            const next = new Map(prev);
            // 检查是否已存在（避免重复）
            if (!next.has(newNode.id)) {
              next.set(newNode.id, {
                type: 'node',
                nodeId: targetNodeId,
                text: newNode.text || '新节点',
                tempId: newNode.id,
              });
            }
            return next;
          });
        }
      });

      setNodeCardsMapVersion(prev => prev + 1);
      setExpandedNodes(prev => new Set(prev).add(targetNodeId));

      // 如果是剪切，清空剪贴板；如果是复制，保留
      if (clipboard.type === 'cut') {
        setClipboard(null);
      }
    } else if (clipboard.item.type === 'card') {
      const sourceCardId = clipboard.item.cardId || '';
      const sourceNodeId = clipboard.item.nodeId || '';

      // 找到源卡片
      const sourceCards = nodeCardsMap[sourceNodeId] || [];
      const sourceCard = sourceCards.find((c: Card) => c.docId === sourceCardId);
      
      // 如果源卡片不存在，可能是已经被删除或移动了
      if (!sourceCard) {
        // 如果是剪切操作，清空剪贴板
        if (clipboard.type === 'cut') {
          setClipboard(null);
        }
        return;
      }
      
      // 如果剪切的是临时卡片（已经粘贴过的），需要先清理 pendingCreates 和 pendingDeletes
      if (clipboard.type === 'cut' && sourceCardId.startsWith('temp-')) {
        // 清理 pendingCreates 中的旧记录
        setPendingCreates(prev => {
          const next = new Map(prev);
          next.delete(sourceCardId);
          return next;
        });
        
        // 清理 pendingDeletes 中的旧记录（如果存在）
        setPendingDeletes(prev => {
          const next = new Map(prev);
          next.delete(sourceCardId);
          return next;
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

          // 如果源卡片是临时卡片（已经粘贴过的），不需要添加到 pendingDeletes
          // 只需要清理 pendingCreates
          if (sourceCardId.startsWith('temp-')) {
            setPendingCreates(prev => {
              const next = new Map(prev);
              next.delete(sourceCardId);
              return next;
            });
          } else {
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
      setPendingCreates(prev => {
        const next = new Map(prev);
        // 检查是否已存在（避免重复）
        if (!next.has(newCardId)) {
          next.set(newCardId, {
            type: 'card',
            nodeId: targetNodeId,
            title: newCard.title || '新卡片',
            tempId: newCardId,
          });
        }
        return next;
      });

      setNodeCardsMapVersion(prev => prev + 1);

      // 如果是剪切，清空剪贴板；如果是复制，保留
      if (clipboard.type === 'cut') {
        setClipboard(null);
      }
    }

    setContextMenu(null);
  }, [clipboard, mindMap, setMindMap]);

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
    if (clipboard && clipboard.type === 'copy') {
      if (clipboard.item.type === 'node') {
        const nodeId = clipboard.item.nodeId || '';
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
      } else if (clipboard.item.type === 'card') {
        const cardId = clipboard.item.cardId || '';
        const nodeId = clipboard.item.nodeId || '';
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
          
          setPendingCreates(prev => {
            const next = new Map(prev);
            next.set(tempId, newChildNode);
            return next;
          });
          
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
            setExpandedNodes(prev => new Set(prev).add(op.parentId));
          }
        } else if (op.type === 'create_card') {
          const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newCard: PendingCreate = {
            type: 'card',
            nodeId: op.nodeId,
            title: op.title || '新卡片',
            tempId,
          };
          
          setPendingCreates(prev => {
            const next = new Map(prev);
            next.set(tempId, newCard);
            return next;
          });
          
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
            setExpandedNodes(prev => new Set(prev).add(targetParentId));
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
          setExpandedNodes(prev => new Set(prev).add(targetNodeId));
          
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
  }, [mindMap, setMindMap, selectedFile, editorInstance, setFileContent]);

  // 将 executeAIOperations 赋值给 ref
  useEffect(() => {
    executeAIOperationsRef.current = executeAIOperations;
  }, [executeAIOperations]);

  // 删除节点或卡片（前端操作）
  const handleDelete = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      // 检查是否有子节点或卡片
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const hasCards = nodeCardsMap[file.nodeId || '']?.length > 0;
      const hasChildren = mindMap.edges.some(e => e.source === file.nodeId);
      
      if (hasCards || hasChildren) {
        Notification.error('无法删除：该节点包含子节点或卡片');
        setContextMenu(null);
        return;
      }
      
      // 添加到待删除列表
      setPendingDeletes(prev => {
        const next = new Map(prev);
        next.set(file.nodeId || '', {
          type: 'node',
          id: file.nodeId || '',
        });
        return next;
      });
      
      // 从 mindMap 中移除（前端显示）
      setMindMap(prev => ({
        ...prev,
        nodes: prev.nodes.filter(n => n.id !== file.nodeId),
        edges: prev.edges.filter(e => e.source !== file.nodeId && e.target !== file.nodeId),
      }));
    } else if (file.type === 'card') {
      // 添加到待删除列表
      setPendingDeletes(prev => {
        const next = new Map(prev);
        next.set(file.cardId || '', {
          type: 'card',
          id: file.cardId || '',
          nodeId: file.nodeId,
        });
        return next;
      });
      
      // 从 nodeCardsMap 中移除（前端显示）
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === file.cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    setContextMenu(null);
  }, [mindMap.edges]);

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
        newDropPosition = 'into';
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
      // 拖动节点到节点，放在内部（作为子节点）
      newDropPosition = 'into';
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
  }, [draggedFile]);

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
        // 移动节点到目标节点下（改变父子关系）
        // 需要检查是否会造成循环（不能将节点拖到自己或自己的子节点下）
        const draggedNodeId = draggedFile.nodeId || '';
        const targetNodeId = targetFile.nodeId || '';
        
        // 检查是否会造成循环：检查目标节点是否是拖动节点的子节点
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
          // 获取拖动节点的所有子节点（递归）
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
          
          // 更新本地数据
          setMindMap(prev => ({
            ...prev,
            edges: newEdges,
          }));
          
          // 记录拖动操作，待保存（记录拖动节点和所有子节点）
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
  }, [draggedFile, dropPosition, mindMap.edges]);

  // 使用 ref 跟踪当前选中的文件ID，避免在fileContent变化时重新初始化
  const selectedFileIdRef = useRef<string | null>(null);
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
            // 不自动保存，只更新内容
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
          <div style={{ display: 'flex', gap: '4px' }}>
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
          </div>
        </div>
        <div style={{ padding: '8px 0' }}>
          {explorerMode === 'tree' ? (
            fileTree.map((file) => {
            const isSelected = selectedFile?.id === file.id;
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
          ) : (
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
                    粘贴
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
              disabled={isCommitting}
              style={{
                padding: '4px 12px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: (pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0) ? '#28a745' : '#6c757d',
                color: '#fff',
                cursor: isCommitting ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: '500',
                opacity: isCommitting ? 0.6 : 1,
              }}
              title={(pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0) ? '没有待保存的更改' : '保存所有更改'}
            >
              {isCommitting ? '保存中...' : `保存更改 (${pendingChanges.size + pendingDragChanges.size + pendingRenames.size})`}
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


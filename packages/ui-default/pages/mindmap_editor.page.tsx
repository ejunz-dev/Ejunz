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
}

type FileItem = {
  type: 'node' | 'card';
  id: string;
  name: string;
  nodeId?: string;
  cardId?: string;
  parentId?: string;
  level: number;
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

function MindMapEditorMode({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  const [mindMap, setMindMap] = useState<MindMapDoc>(initialData);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [pendingRenames, setPendingRenames] = useState<Map<string, PendingRename>>(new Map());
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

    // 递归构建文件树（只显示展开的节点）
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node } = nodeData;
      const isExpanded = expandedNodes.has(nodeId);
      
      // 添加节点
      items.push({
        type: 'node',
        id: nodeId,
        name: node.text || '未命名节点',
        nodeId: nodeId,
        parentId,
        level,
      });

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
          items.push({
            type: 'card',
            id: `card-${card.docId}`,
            name: card.title || '未命名卡片',
            nodeId: card.nodeId || nodeId, // 使用 card.nodeId（如果存在）或当前 nodeId
            cardId: card.docId,
            parentId: card.nodeId || nodeId,
            level: level + 1,
          });
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
  }, [mindMap.nodes, mindMap.edges, nodeCardsMapVersion, expandedNodes]);

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

    // 允许即使没有更改也执行保存（用于刷新或验证）
    // if (!hasContentChanges && !hasDragChanges && !hasRenameChanges) {
    //   Notification.info('没有待保存的更改');
    //   return;
    // }

    setIsCommitting(true);
    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      // 保存内容更改
      if (hasContentChanges) {
        const changes = Array.from(allChanges.values());
        
        // 批量保存所有内容更改
        for (const change of changes) {
          if (change.file.type === 'node') {
            // 保存节点文本
            await request.post(getMindMapUrl('/node', docId), {
              operation: 'update',
              nodeId: change.file.nodeId,
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
            // 保存卡片内容
            await request.post(`/d/${domainId}/mindmap/card/${change.file.cardId}`, {
              operation: 'update',
              nodeId: change.file.nodeId,
              content: change.content,
            });
            
            // 更新本地数据
            const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            if (nodeCardsMap[change.file.nodeId || '']) {
              const cards = nodeCardsMap[change.file.nodeId || ''];
              const cardIndex = cards.findIndex((c: Card) => c.docId === change.file.cardId);
              if (cardIndex >= 0) {
                cards[cardIndex] = { ...cards[cardIndex], content: change.content };
                (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              }
            }
          }
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
            // edges 已经在 handleDrop 中更新到 mindMap.edges，这里需要同步到后端
            const nodeEdges = mindMap.edges.filter(e => e.target === nodeId);
            if (nodeEdges.length > 0) {
              const edge = nodeEdges[0];
              // 删除旧的父节点连接（除了当前边）
              const oldEdges = mindMap.edges.filter(
                e => e.target === nodeId && e.id !== edge.id
              );
              for (const oldEdge of oldEdges) {
                await request.post(getMindMapUrl('/edge', docId), {
                  operation: 'delete',
                  edgeId: oldEdge.id,
                });
              }
              // 创建新边（前端已经创建了临时ID，后端会返回真实ID）
              await request.post(getMindMapUrl('/edge', docId), {
                operation: 'add',
                source: edge.source,
                target: edge.target,
              });
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
            // 保存卡片重命名
            await request.post(`/d/${domainId}/mindmap/card/${rename.file.cardId}`, {
              operation: 'update',
              title: rename.newName,
            });
          }
        }
      }

      const totalChanges = (hasContentChanges ? allChanges.size : 0) + (hasDragChanges ? pendingDragChanges.size : 0) + (hasRenameChanges ? pendingRenames.size : 0);
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
  }, [pendingChanges, pendingDragChanges, pendingRenames, selectedFile, editorInstance, fileContent, docId, getMindMapUrl, mindMap.edges]);

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
        // 只更新本地 edges，不调用后端
        const existingEdge = mindMap.edges.find(
          e => e.source === targetFile.nodeId && e.target === draggedFile.nodeId
        );
        
        if (!existingEdge) {
          // 移除旧的父节点连接
          const oldEdges = mindMap.edges.filter(
            e => e.target === draggedFile.nodeId
          );
          
          // 删除旧边
          const newEdges = mindMap.edges.filter(
            e => !oldEdges.includes(e)
          );
          
          // 创建新边
          const newEdge: MindMapEdge = {
            id: `edge-${targetFile.nodeId}-${draggedFile.nodeId}-${Date.now()}`,
            source: targetFile.nodeId,
            target: draggedFile.nodeId,
          };
          
          newEdges.push(newEdge);
          
          // 更新本地数据
          setMindMap(prev => ({
            ...prev,
            edges: newEdges,
          }));
          
          // 记录拖动操作，待保存
          setPendingDragChanges(prev => new Set(prev).add(`node-${draggedFile.nodeId}`));
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
        }}>
          EXPLORER
        </div>
        <div style={{ padding: '8px 0' }}>
          {fileTree.map((file) => {
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
                }}>
                  {file.name}
                </span>
              )}
            </div>
            );
          })}
        </div>
      </div>

      {/* 右侧编辑器区域 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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

        {/* 编辑器内容 */}
        <div 
          id="editor-container"
          style={{ flex: 1, padding: '0', overflow: 'hidden', position: 'relative', backgroundColor: '#fff' }}
        >
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
      </div>
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


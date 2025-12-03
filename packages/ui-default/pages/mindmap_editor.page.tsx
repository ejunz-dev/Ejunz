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

function MindMapEditorMode({ docId, initialData }: { docId: string; initialData: MindMapDoc }) {
  const [mindMap, setMindMap] = useState<MindMapDoc>(initialData);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const originalContentsRef = useRef<Map<string, string>>(new Map());

  // 获取带 domainId 的 mindmap URL
  const getMindMapUrl = (path: string, docId: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    return `/d/${domainId}/mindmap/${docId}${path}`;
  };

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

    // 递归构建文件树
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node } = nodeData;
      
      // 添加节点
      items.push({
        type: 'node',
        id: nodeId,
        name: node.text || '未命名节点',
        nodeId: nodeId,
        parentId,
        level,
      });

      // 获取该节点的卡片
      const nodeCards = (window as any).UiContext?.nodeCardsMap?.[nodeId] || [];
      nodeCards.forEach((card: Card) => {
        items.push({
          type: 'card',
          id: `card-${card.docId}`,
          name: card.title || '未命名卡片',
          nodeId: nodeId,
          cardId: card.docId,
          parentId: nodeId,
          level: level + 1,
        });
      });

      // 递归处理子节点
      nodeData.children.forEach((childId) => {
        buildTree(childId, level + 1, nodeId);
      });
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });

    return items;
  }, [mindMap.nodes, mindMap.edges]);

  // 选择文件
  const handleSelectFile = useCallback(async (file: FileItem) => {
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
      // 否则从原始数据加载
      if (file.type === 'node') {
        // 加载节点文本
        const node = mindMap.nodes.find(n => n.id === file.nodeId);
        content = node?.text || '';
      } else if (file.type === 'card') {
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

    if (allChanges.size === 0) {
      Notification.info('没有待保存的更改');
      return;
    }

    setIsCommitting(true);
    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      const changes = Array.from(allChanges.values());
      
      // 批量保存所有更改
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

      Notification.success(`已保存 ${changes.length} 个文件的更改`);
      // 清空待提交列表
      setPendingChanges(new Map());
      // 更新原始内容引用
      changes.forEach(change => {
        originalContentsRef.current.set(change.file.id, change.content);
      });
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
    } finally {
      setIsCommitting(false);
    }
  }, [pendingChanges, selectedFile, editorInstance, fileContent, docId, getMindMapUrl]);

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
          {fileTree.map((file) => (
            <div
              key={file.id}
              onClick={() => handleSelectFile(file)}
              style={{
                padding: `4px ${8 + file.level * 16}px`,
                cursor: 'pointer',
                fontSize: '13px',
                color: selectedFile?.id === file.id ? '#fff' : '#24292e',
                backgroundColor: selectedFile?.id === file.id ? '#0366d6' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              onMouseEnter={(e) => {
                if (selectedFile?.id !== file.id) {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }
              }}
              onMouseLeave={(e) => {
                if (selectedFile?.id !== file.id) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <span style={{ fontSize: '16px' }}>
                {file.type === 'node' ? '📄' : '📝'}
              </span>
              <span style={{ 
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {file.name}
              </span>
            </div>
          ))}
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
            {pendingChanges.size > 0 && (
              <span style={{ fontSize: '12px', color: '#586069' }}>
                {pendingChanges.size} 个文件已修改
              </span>
            )}
            <button
              onClick={handleSaveAll}
              disabled={isCommitting || pendingChanges.size === 0}
              style={{
                padding: '4px 12px',
                border: '1px solid #d1d5da',
                borderRadius: '3px',
                backgroundColor: pendingChanges.size > 0 ? '#28a745' : '#6c757d',
                color: '#fff',
                cursor: (isCommitting || pendingChanges.size === 0) ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: '500',
                opacity: (isCommitting || pendingChanges.size === 0) ? 0.6 : 1,
              }}
              title={pendingChanges.size === 0 ? '没有待保存的更改' : '保存所有更改'}
            >
              {isCommitting ? '保存中...' : `保存更改 (${pendingChanges.size})`}
            </button>
          </div>
        </div>

        {/* 编辑器内容 */}
        <div 
          id="editor-container"
          style={{ flex: 1, padding: '0', overflow: 'hidden', position: 'relative', backgroundColor: '#fff' }}
        >
          {selectedFile ? (
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
              请从左侧选择一个文件
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


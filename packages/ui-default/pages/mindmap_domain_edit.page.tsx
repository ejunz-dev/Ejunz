import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, pjax } from 'vj/utils';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  ReactFlowInstance,
  NodeTypes,
  EdgeTypes,
  Handle,
  Position,
  Connection,
  addEdge,
  BaseEdge,
  getBezierPath,
  EdgeProps,
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css';

interface MindMapItem {
  docId: string;
  mmid: number;
  title: string;
  content?: string;
  parentId?: string;
  domainPosition?: { x: number; y: number };
  views?: number;
  updateAt?: string;
  nodes?: any[];
}

const getTheme = (): 'light' | 'dark' => UserContext.theme === 'dark' ? 'dark' : 'light';

// 自定义节点组件（可编辑）
const MindMapDomainEditNode = ({ data, selected, id }: { data: any; selected: boolean; id: string }) => {
  const mindMap = data.mindMap as MindMapItem;
  const isPending = data.isPending as boolean | undefined; // 是否为待创建的临时节点
  const [isEditing, setIsEditing] = useState(isPending || false); // 临时节点默认进入编辑状态
  const [editTitle, setEditTitle] = useState(isPending ? '' : mindMap.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      if (isPending) {
        // 临时节点不选中文本，让用户直接输入
        inputRef.current.focus();
      } else {
        inputRef.current.select();
      }
    }
  }, [isEditing, isPending]);

  const handleDoubleClick = () => {
    if (!isPending) {
      setIsEditing(true);
    }
  };

  const handleBlur = () => {
    if (isPending) {
      // 临时节点：如果为空，取消创建
      if (!editTitle || !editTitle.trim()) {
        if (data.onCancel) {
          data.onCancel(id);
        }
        return;
      }
      // 临时节点：有内容，提交创建
      if (data.onCreate) {
        data.onCreate(id, editTitle.trim());
      }
    } else {
      // 普通节点：编辑完成
      setIsEditing(false);
      if (data.onTitleChange && editTitle !== mindMap.title) {
        data.onTitleChange(id, editTitle);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isPending) {
        // 临时节点：Enter 提交创建
        if (editTitle && editTitle.trim()) {
          if (data.onCreate) {
            data.onCreate(id, editTitle.trim());
          }
        } else {
          // 空内容，取消创建
          if (data.onCancel) {
            data.onCancel(id);
          }
        }
      } else {
        // 普通节点：Enter 完成编辑
        handleBlur();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (isPending) {
        // 临时节点：ESC 取消创建
        if (data.onCancel) {
          data.onCancel(id);
        }
      } else {
        // 普通节点：ESC 取消编辑
        setEditTitle(mindMap.title);
        setIsEditing(false);
      }
    }
  };

  const theme = getTheme();
  const isDark = theme === 'dark';

  return (
    <div
      style={{
        padding: '12px 16px',
        background: isPending 
          ? (isDark ? '#4a3a1a' : '#fff3cd')
          : (isDark 
            ? (selected ? '#1e3a5f' : '#323334')
            : (selected ? '#e3f2fd' : '#fff')),
        border: `2px solid ${isPending 
          ? (isDark ? '#ffc107' : '#ffc107')
          : (isDark 
            ? (selected ? '#55b6e2' : '#555')
            : (selected ? '#2196f3' : '#ddd'))}`,
        borderRadius: '8px',
        minWidth: '200px',
        boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.1)',
        cursor: 'default',
        transition: 'all 0.2s',
        position: 'relative',
        color: isDark ? '#eee' : '#24292e',
      }}
      onDoubleClick={handleDoubleClick}
    >
      {!isPending && <Handle type="target" position={Position.Top} style={{ background: isDark ? '#888' : '#555' }} />}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={isPending ? '请输入思维导图标题...' : ''}
          style={{
            width: '100%',
            padding: '4px 8px',
            border: `2px solid ${isDark ? '#55b6e2' : '#2196f3'}`,
            borderRadius: '4px',
            fontSize: '14px',
            fontWeight: 'bold',
            background: isDark ? '#424242' : '#fff',
            color: isDark ? '#eee' : '#24292e',
          }}
        />
      ) : (
        <div style={{ fontWeight: 'bold', marginBottom: '4px', fontSize: '14px', color: isDark ? '#eee' : '#24292e' }}>
          {mindMap.title}
        </div>
      )}
      {mindMap.content && !isEditing && !isPending && (
        <div style={{ fontSize: '12px', color: isDark ? '#bdbdbd' : '#666', marginTop: '4px' }}>
          {mindMap.content.length > 50 ? mindMap.content.substring(0, 50) + '...' : mindMap.content}
        </div>
      )}
      {!isEditing && !isPending && (
        <div style={{ fontSize: '11px', color: isDark ? '#999' : '#999', marginTop: '8px', display: 'flex', gap: '12px' }}>
          <span>ID: {mindMap.mmid}</span>
          {mindMap.views !== undefined && <span>浏览: {mindMap.views}</span>}
        </div>
      )}
      {isPending && (
        <div style={{ fontSize: '11px', color: isDark ? '#bdbdbd' : '#999', marginTop: '8px', fontStyle: 'italic' }}>
          按 Enter 确认，ESC 取消
        </div>
      )}
      {!isPending && <Handle type="source" position={Position.Bottom} style={{ background: isDark ? '#888' : '#555' }} />}
    </div>
  );
};

// 自定义边组件 - 虚线样式（带动画）
const CustomDottedEdge = ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style }: EdgeProps) => {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition || Position.Bottom,
    targetPosition: targetPosition || Position.Top,
  });

  const theme = getTheme();
  const isDark = theme === 'dark';
  const strokeColor = isDark ? '#55b6e2' : '#333';
  const strokeWidth = isDark ? 2.5 : 2.5;

  return (
    <g>
      <defs>
        <style>
          {`
            @keyframes dash-${id.replace(/[^a-zA-Z0-9]/g, '-')} {
              to {
                stroke-dashoffset: -12;
              }
            }
          `}
        </style>
      </defs>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray="8,4"
        style={{
          animation: `dash-${id.replace(/[^a-zA-Z0-9]/g, '-')} 1s linear infinite`,
        }}
      />
    </g>
  );
};

const customNodeTypes: NodeTypes = {
  mindmapDomainEdit: MindMapDomainEditNode,
};

const customEdgeTypes: EdgeTypes = {
  dotted: CustomDottedEdge,
};

// 使用 dagre 进行层级布局
const getLayoutedElements = (nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ 
    rankdir: direction,
    nodesep: 150,
    ranksep: 200,
    marginx: 50,
    marginy: 50,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 250, height: 120 });
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
        x: nodeWithPosition.x - 125,
        y: nodeWithPosition.y - 60,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

function MindMapDomainEditView() {
  const [mindMaps, setMindMaps] = useState<MindMapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; position?: { x: number; y: number }; nodeId?: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // 处理标题修改
  const handleTitleChange = useCallback((nodeId: string, newTitle: string) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === nodeId) {
          const updatedMindMap = { ...(node.data.mindMap as MindMapItem), title: newTitle };
          return {
            ...node,
            data: {
              ...node.data,
              mindMap: updatedMindMap,
            },
          };
        }
        return node;
      })
    );
    setMindMaps((maps) =>
      maps.map((mm) => (mm.docId === nodeId ? { ...mm, title: newTitle } : mm))
    );
  }, [setNodes]);

  // 加载所有 mindmap 数据
  const loadMindMaps = useCallback(async () => {
    try {
      setLoading(true);
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      const response = await request.get(`/d/${domainId}/mindmap/edit`);
      const allMindMaps = response.mindMaps || [];
      setMindMaps(allMindMaps);
      
      // 转换为 ReactFlow 的 nodes 和 edges
      const mindMapMap = new Map<string, MindMapItem>();
      allMindMaps.forEach((mm: MindMapItem) => {
        mindMapMap.set(mm.docId, mm);
      });

      // 创建节点（如果有保存的位置，使用保存的位置，否则使用布局算法计算的位置）
      const flowNodes: Node[] = allMindMaps.map((mm: MindMapItem) => ({
        id: mm.docId,
        type: 'mindmapDomainEdit',
        data: { 
          mindMap: mm,
          onTitleChange: handleTitleChange,
        },
        position: mm.domainPosition || { x: 0, y: 0 }, // 使用保存的位置
      }));

      // 创建边（基于 parentId）
      const flowEdges: Edge[] = [];
      allMindMaps.forEach((mm: MindMapItem) => {
        if (mm.parentId && mindMapMap.has(mm.parentId)) {
          flowEdges.push({
            id: `edge-${mm.parentId}-${mm.docId}`,
            source: mm.parentId,
            target: mm.docId,
            type: 'dotted', // 使用自定义虚线边类型
            animated: false,
          });
        }
      });

      // 应用布局（对所有节点应用布局以计算层级关系，然后用保存的位置覆盖）
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(flowNodes, flowEdges, 'TB');
      
      // 合并布局后的节点和保存的位置
      const finalNodes = layoutedNodes.map(layoutedNode => {
        const mindMap = (layoutedNode.data.mindMap as MindMapItem);
        // 如果节点有保存的位置，使用保存的位置，否则使用布局算法计算的位置
        if (mindMap.domainPosition) {
          return {
            ...layoutedNode,
            position: mindMap.domainPosition,
          };
        }
        return layoutedNode;
      });
      
      setNodes(finalNodes);
      setEdges(layoutedEdges);
    } catch (error: any) {
      Notification.error('加载思维导图失败: ' + (error.message || '未知错误'));
    } finally {
      setLoading(false);
    }
  }, [setNodes, setEdges]);

  // 取消创建临时节点
  const handleCancelPendingNode = useCallback((nodeId: string) => {
    setNodes((nds) => nds.filter((node) => node.id !== nodeId));
  }, [setNodes]);

  // 创建临时节点（提交到后端）
  const handleCreatePendingNode = useCallback(async (nodeId: string, title: string) => {
    if (!title || !title.trim()) {
      // 如果标题为空，删除临时节点
      handleCancelPendingNode(nodeId);
      return;
    }

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      // 获取临时节点的位置
      const tempNode = nodes.find(n => n.id === nodeId);
      const position = tempNode?.position || { x: 0, y: 0 };
      
      // 先删除临时节点
      setNodes((nds) => nds.filter((node) => node.id !== nodeId));
      
      // 提交到后端创建
      const response = await request.post(`/d/${domainId}/mindmap/create`, {
        title: title.trim(),
        content: '',
      });

      Notification.success('思维导图创建成功');
      
      // 重新加载数据
      await loadMindMaps();
      
      // 如果有位置信息，移动新节点到该位置
      if (response.docId) {
        setTimeout(() => {
          setNodes((nds) =>
            nds.map((node) =>
              node.id === response.docId.toString()
                ? { ...node, position }
                : node
            )
          );
        }, 100);
      }
    } catch (error: any) {
      Notification.error('创建失败: ' + (error.message || '未知错误'));
      // 创建失败，删除临时节点
      handleCancelPendingNode(nodeId);
    }
  }, [nodes, setNodes, loadMindMaps, handleCancelPendingNode]);

  // 处理画布右键菜单 - 直接在右键位置创建临时节点
  const handlePaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    if (reactFlowInstance) {
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      
      // 创建临时节点ID
      const tempNodeId = `temp-${Date.now()}`;
      
      // 创建临时节点
      const tempNode: Node = {
        id: tempNodeId,
        type: 'mindmapDomainEdit',
        position,
        data: {
          mindMap: {
            docId: tempNodeId,
            mmid: 0,
            title: '',
          } as MindMapItem,
          isPending: true,
          onCreate: handleCreatePendingNode,
          onCancel: handleCancelPendingNode,
        },
      };
      
      setNodes((nds) => [...nds, tempNode]);
    }
  }, [reactFlowInstance, setNodes, handleCreatePendingNode, handleCancelPendingNode]);

  // 处理节点右键菜单
  const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    // 如果是临时节点，不显示右键菜单
    if (node.data?.isPending) {
      return;
    }
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id,
    });
  }, []);

  // 处理画布点击 - 关闭右键菜单
  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  // 删除节点
  const handleDeleteNode = useCallback(async (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const mindMap = node.data.mindMap as MindMapItem;
    if (!confirm(`确定要删除思维导图"${mindMap.title}"吗？`)) {
      return;
    }

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      await request.post(`/d/${domainId}/mindmap/${nodeId}/edit`, {
        operation: 'delete',
      });

      Notification.success('思维导图已删除');
      await loadMindMaps();
    } catch (error: any) {
      Notification.error('删除失败: ' + (error.message || '未知错误'));
    }
    setContextMenu(null);
  }, [nodes, loadMindMaps]);

  // 处理连接
  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => addEdge({
      ...params,
      type: 'dotted', // 新连接的边也使用虚线样式
    }, eds));
  }, [setEdges]);

  // 保存所有更改
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      // 保存所有节点的 parentId 关系（基于 edges）
      const updates: Array<{ docId: string; parentId?: string }> = [];
      
      // 构建 parentId 映射
      const parentIdMap = new Map<string, string>();
      edges.forEach((edge) => {
        parentIdMap.set(edge.target, edge.source);
      });

      // 收集所有需要更新的节点
      nodes.forEach((node) => {
        const docId = node.id;
        const newParentId = parentIdMap.get(docId);
        const mindMap = node.data.mindMap as MindMapItem;
        const oldParentId = mindMap.parentId;
        
        // 如果 parentId 发生变化，需要更新
        if (newParentId !== oldParentId) {
          updates.push({
            docId,
            parentId: newParentId,
          });
        }
        
        // 如果标题发生变化，也需要更新
        if (mindMap.title !== (mindMaps.find(m => m.docId === docId)?.title || '')) {
          // 标题更新已经在 handleTitleChange 中处理了，这里只需要更新 parentId
        }
      });

      // 批量更新 parentId
      for (const update of updates) {
        try {
          await request.post(`/d/${domainId}/mindmap/${update.docId}/edit`, {
            operation: 'update',
            parentId: update.parentId || null, // 如果 parentId 为空，设置为 null
          });
        } catch (error: any) {
          console.error(`Failed to update mindmap ${update.docId}:`, error);
        }
      }

      // 更新标题和位置（如果有变化）
      for (const node of nodes) {
        const mindMap = node.data.mindMap as MindMapItem;
        const originalMindMap = mindMaps.find(m => m.docId === mindMap.docId);
        const updates: any = {};
        let hasUpdates = false;
        
        // 检查标题变化
        if (originalMindMap && mindMap.title !== originalMindMap.title) {
          updates.title = mindMap.title;
          hasUpdates = true;
        }
        
        // 检查位置变化
        const currentPosition = { x: node.position.x, y: node.position.y };
        const savedPosition = originalMindMap?.domainPosition;
        if (!savedPosition || 
            Math.abs(currentPosition.x - savedPosition.x) > 1 || 
            Math.abs(currentPosition.y - savedPosition.y) > 1) {
          updates.domainPosition = currentPosition;
          hasUpdates = true;
        }
        
        if (hasUpdates) {
          try {
            await request.post(`/d/${domainId}/mindmap/${mindMap.docId}/edit`, {
              operation: 'update',
              ...updates,
            });
          } catch (error: any) {
            console.error(`Failed to update mindmap ${mindMap.docId}:`, error);
          }
        }
      }

      Notification.success('保存成功');
      await loadMindMaps();
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
    } finally {
      setIsSaving(false);
    }
  }, [nodes, edges, mindMaps, loadMindMaps]);

  useEffect(() => {
    loadMindMaps();
  }, []);

  // 当 reactFlowInstance 可用时，适应视图
  useEffect(() => {
    if (reactFlowInstance && nodes.length > 0) {
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2 });
      }, 100);
    }
  }, [reactFlowInstance, nodes.length]);

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <div>加载中...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 工具栏 */}
      <div style={{ padding: '15px', background: '#f5f5f5', borderBottom: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '16px', fontWeight: 'bold' }}>编辑导图结构</div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          style={{
            padding: '8px 16px',
            background: isSaving ? '#ccc' : '#4caf50',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: isSaving ? 'not-allowed' : 'pointer',
            fontSize: '14px',
          }}
        >
          {isSaving ? '保存中...' : '保存'}
        </button>
      </div>

      {/* ReactFlow 画布 */}
      <div ref={reactFlowWrapper} style={{ flex: 1, width: '100%', minHeight: '600px' }}>
        {nodes.length === 0 ? (
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            height: '100%',
            color: getTheme() === 'dark' ? '#bdbdbd' : '#999',
            fontSize: '16px'
          }}>
            暂无思维导图，右键点击画布创建新节点
          </div>
        ) : (
          <>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onPaneContextMenu={handlePaneContextMenu}
              onNodeContextMenu={handleNodeContextMenu}
              onPaneClick={handlePaneClick}
              onInit={setReactFlowInstance}
              nodeTypes={customNodeTypes}
              edgeTypes={customEdgeTypes}
              fitView
              nodesDraggable={true}
              nodesConnectable={true}
              elementsSelectable={true}
              panOnDrag={[1, 2]}
              zoomOnScroll={true}
              zoomOnPinch={true}
              deleteKeyCode="Delete"
              style={{
                background: getTheme() === 'dark' ? '#121212' : '#fafafa',
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
              <Controls />
            </ReactFlow>


            {/* 节点右键菜单 */}
            {contextMenu && contextMenu.position === undefined && (
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
                  minWidth: '150px',
                  padding: '4px 0',
                }}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div
                  style={{
                    padding: '8px 16px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: '#f44336',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f5f5f5';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    const selectedNode = nodes.find(n => n.selected);
                    if (selectedNode) {
                      handleDeleteNode(selectedNode.id);
                    }
                  }}
                >
                  删除
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('mindmap_domain_edit', () => {
  const $container = $('#mindmap-domain-edit-container');
  if ($container.length) {
    ReactDOM.render(<MindMapDomainEditView />, $container[0]);
  }
});

export default page;

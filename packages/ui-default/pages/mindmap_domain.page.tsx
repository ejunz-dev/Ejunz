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

// 自定义节点组件
const MindMapDomainNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const mindMap = data.mindMap as MindMapItem;
  
  return (
    <div
      style={{
        padding: '12px 16px',
        background: selected ? '#e3f2fd' : '#fff',
        border: `2px solid ${selected ? '#2196f3' : '#ddd'}`,
        borderRadius: '8px',
        minWidth: '200px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        cursor: 'default',
        transition: 'all 0.2s',
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#555' }} />
      <div style={{ fontWeight: 'bold', marginBottom: '4px', fontSize: '14px' }}>
        {mindMap.title}
      </div>
      {mindMap.content && (
        <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
          {mindMap.content.length > 50 ? mindMap.content.substring(0, 50) + '...' : mindMap.content}
        </div>
      )}
      <div style={{ fontSize: '11px', color: '#999', marginTop: '8px', display: 'flex', gap: '12px' }}>
        <span>ID: {mindMap.mmid}</span>
        {mindMap.views !== undefined && <span>浏览: {mindMap.views}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#555' }} />
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
        stroke="#fff"
        strokeWidth={2}
        strokeDasharray="8,4"
        style={{
          animation: `dash-${id.replace(/[^a-zA-Z0-9]/g, '-')} 1s linear infinite`,
        }}
      />
    </g>
  );
};

const customNodeTypes: NodeTypes = {
  mindmapDomain: MindMapDomainNode,
};

const customEdgeTypes: EdgeTypes = {
  dotted: CustomDottedEdge,
};

// 使用 dagre 进行层级布局（导图模式）
const getLayoutedElements = (nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ 
    rankdir: direction,
    nodesep: 150, // 节点水平间距
    ranksep: 200,  // 层级间距
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

function MindMapDomainView() {
  const [mindMaps, setMindMaps] = useState<MindMapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const loadMindMapsRef = useRef<(() => Promise<void>) | null>(null);
  const createChildMindMapRef = useRef<((parentId: string) => Promise<void>) | null>(null);

  // 加载所有 mindmap 数据
  const loadMindMaps = useCallback(async () => {
    try {
      setLoading(true);
      const domainId = (window as any).UiContext?.domainId || 'system';
      const url = new URL(window.location.href);
      const q = url.searchParams.get('q') || '';
      setSearchQuery(q);
      
      // 请求所有数据（all=true）
      const response = await request.get(`/d/${domainId}/mindmap`, { 
        params: { all: true, q } 
      });
      
      const allMindMaps = response.mindMaps || [];
      setMindMaps(allMindMaps);
      
      // 转换为 ReactFlow 的 nodes 和 edges
      const mindMapMap = new Map<string, MindMapItem>();
      allMindMaps.forEach((mm: MindMapItem) => {
        mindMapMap.set(mm.docId, mm);
      });

      // 创建节点（如果有保存的位置，使用保存的位置，否则使用布局算法）
      const flowNodes: Node[] = allMindMaps.map((mm: MindMapItem) => ({
        id: mm.docId,
        type: 'mindmapDomain',
        data: { 
          mindMap: mm,
        },
        position: mm.domainPosition || { x: 0, y: 0 }, // 使用保存的位置或默认位置
      }));

      // 创建边（基于 parentId）
      const flowEdges: Edge[] = [];
      allMindMaps.forEach((mm: MindMapItem) => {
        if (mm.parentId && mindMapMap.has(mm.parentId)) {
          flowEdges.push({
            id: `edge-${mm.parentId}-${mm.docId}`,
            source: mm.parentId,
            target: mm.docId,
            type: 'dotted', // 使用自定义虚线边类型（带动画）
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

  // 处理搜索
  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const domainId = (window as any).UiContext?.domainId || 'system';
    const url = new URL(window.location.href);
    if (searchQuery) {
      url.searchParams.set('q', searchQuery);
    } else {
      url.searchParams.delete('q');
    }
    url.searchParams.delete('page');
    pjax.request({ url: url.toString() }).then(() => {
      loadMindMaps();
    });
  }, [searchQuery, loadMindMaps]);

  // 处理搜索输入变化
  const handleSearchInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  // 处理节点点击 - 不执行任何操作（已禁用跳转）
  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    // 如果点击的是按钮，不处理，让按钮的 onClick 处理
    const target = event.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.closest('button')) {
      event.stopPropagation();
      return;
    }
    // 点击节点不做任何操作，只通过右键菜单访问
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // 处理节点右键菜单
  const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
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

  // 访问思维导图
  const handleVisitMindMap = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      const mindMap = (node.data.mindMap as MindMapItem);
      const domainId = (window as any).UiContext?.domainId || 'system';
      window.location.href = `/d/${domainId}/mindmap/${mindMap.docId}`;
    }
    setContextMenu(null);
  }, [nodes]);

  // 创建子导图
  const handleCreateChildMindMap = useCallback(async (parentId: string) => {
    const title = prompt('请输入新思维导图的标题:');
    if (!title || !title.trim()) {
      return;
    }

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      const response = await request.post(`/d/${domainId}/mindmap/create`, {
        title: title.trim(),
        content: '',
        parentId: parentId, // 传递 parentId
      });

      Notification.success('思维导图创建成功');
      // 重新加载数据
      if (loadMindMapsRef.current) {
        await loadMindMapsRef.current();
      }
      
      // 跳转到新创建的思维导图
      if (response.docId) {
        window.location.href = `/d/${domainId}/mindmap/${response.docId}`;
      }
    } catch (error: any) {
      Notification.error('创建失败: ' + (error.message || '未知错误'));
    }
  }, []);

  // 保存函数引用
  useEffect(() => {
    loadMindMapsRef.current = loadMindMaps;
    createChildMindMapRef.current = handleCreateChildMindMap;
  }, [loadMindMaps, handleCreateChildMindMap]);

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <div>加载中...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 搜索栏 */}
      <div style={{ padding: '15px', background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchInputChange}
            placeholder="搜索思维导图..."
            style={{
              flex: 1,
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
            }}
          />
          <button
            type="submit"
            style={{
              padding: '8px 16px',
              background: '#2196f3',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            搜索
          </button>
        </form>
      </div>

      {/* ReactFlow 画布 */}
      <div ref={reactFlowWrapper} style={{ flex: 1, width: '100%', minHeight: '600px' }}>
        {nodes.length === 0 ? (
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            height: '100%',
            color: '#999',
            fontSize: '16px'
          }}>
            暂无思维导图
          </div>
        ) : (
          <>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={handleNodeClick}
            onNodeContextMenu={handleNodeContextMenu}
            onPaneClick={handlePaneClick}
            onInit={setReactFlowInstance}
            nodeTypes={customNodeTypes}
            edgeTypes={customEdgeTypes}
            fitView
              nodesDraggable={true}
              nodesConnectable={false}
              elementsSelectable={true}
              panOnDrag={[1, 2]} // 只在鼠标中键和右键时拖拽，左键用于点击
              zoomOnScroll={true}
              zoomOnPinch={true}
              style={{
                background: '#fafafa',
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
              <Controls />
            </ReactFlow>

            {/* 右键菜单 */}
            {contextMenu && (
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
                    color: '#333',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f5f5f5';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => handleVisitMindMap(contextMenu.nodeId)}
                >
                  访问思维导图
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('mindmap_domain', () => {
  const $container = $('#mindmap-domain-container');
  if ($container.length) {
    ReactDOM.render(<MindMapDomainView />, $container[0]);
  }
});

export default page;

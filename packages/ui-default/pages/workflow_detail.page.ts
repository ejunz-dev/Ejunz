import $ from 'jquery';
import React, { useMemo } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  MarkerType,
  NodeTypes,
  BackgroundVariant,
  MiniMap,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';

interface WorkflowNode {
  nid: number;
  name: string;
  nodeType: string;
  type: string;
  position: { x: number; y: number };
  config: Record<string, any>;
  connections: Array<{ targetNodeId: number; condition?: string }>;
}

// 自定义节点组件（只读模式）
const CustomNode = ({ data }: { data: any }) => {
  const getNodeColor = (nodeType: string, type: string) => {
    if (type === 'trigger') {
      return '#4caf50'; // 绿色表示触发器
    } else if (type === 'action') {
      return '#2196f3'; // 蓝色表示执行
    } else if (nodeType === 'condition') {
      return '#ff9800'; // 橙色表示条件
    } else if (nodeType === 'delay') {
      return '#9c27b0'; // 紫色表示延迟
    }
    return '#757575'; // 灰色默认
  };

  const color = getNodeColor(data.nodeType, data.type);

  return (
    <div
      style={{
        padding: '10px 15px',
        background: '#fff',
        border: `2px solid ${color}`,
        borderRadius: '8px',
        minWidth: '150px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: '5px', fontSize: '14px', color: color }}>
        {data.label}
      </div>
      <div style={{ fontSize: '12px', color: '#666' }}>
        {data.nodeType}
      </div>
    </div>
  );
};

const customNodeTypes: NodeTypes = {
  custom: CustomNode,
};

// 工作流可视化组件（只读）
function WorkflowViewer({ workflowId, initialNodes }: { workflowId: number; initialNodes: WorkflowNode[] }) {
  // 将 WorkflowNode 转换为 ReactFlow 的 Node 格式
  const initialFlowNodes = useMemo(() => {
    console.log('Converting nodes to flow nodes:', initialNodes);
    return initialNodes.map((node, index) => {
      // 如果节点没有位置，使用默认位置
      const position = node.position && typeof node.position === 'object' && node.position.x !== undefined && node.position.y !== undefined
        ? node.position
        : { x: 100 + index * 200, y: 100 + Math.floor(index / 3) * 150 };
      
      return {
        id: `node-${node.nid}`,
        type: 'custom',
        position,
        data: {
          label: node.name || `节点 ${node.nid}`,
          nodeType: node.nodeType || 'unknown',
          type: node.type || 'action',
          originalNode: node,
        },
      } as Node;
    });
  }, [initialNodes]);

  // 将 connections 转换为 ReactFlow 的 Edge 格式
  const initialFlowEdges = useMemo(() => {
    const edges: Edge[] = [];
    initialNodes.forEach((node) => {
      node.connections?.forEach((conn) => {
        edges.push({
          id: `edge-${node.nid}-${conn.targetNodeId}`,
          source: `node-${node.nid}`,
          target: `node-${conn.targetNodeId}`,
          type: 'smoothstep',
          animated: true,
          markerEnd: {
            type: MarkerType.ArrowClosed,
          },
          label: conn.condition || '',
        });
      });
    });
    return edges;
  }, [initialNodes]);

  // 使用 React Flow 的状态管理
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlowEdges);

  // 当 initialNodes 变化时更新节点和边
  React.useEffect(() => {
    setNodes(initialFlowNodes);
    setEdges(initialFlowEdges);
  }, [initialFlowNodes, initialFlowEdges, setNodes, setEdges]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={customNodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

const page = new NamedPage('workflow_detail', async () => {
  try {
    // 渲染工作流可视化
    const $viewer = $('#workflow-viewer');
    if ($viewer.length) {
      const workflowIdStr = $viewer.data('workflow-id');
      if (!workflowIdStr) {
        console.warn('Workflow ID not found in data attribute');
        return;
      }

      const workflowId = parseInt(String(workflowIdStr), 10);
      if (isNaN(workflowId) || workflowId < 1) {
        console.error('Invalid workflow ID:', workflowIdStr);
        return;
      }

      let nodes: WorkflowNode[] = [];
      try {
        // 使用 attr() 获取原始字符串，避免 jQuery 的自动解析
        const nodesDataStr = $viewer.attr('data-workflow-nodes');
        console.log('Raw nodes data string from DOM:', nodesDataStr);
        
        if (nodesDataStr) {
          try {
            // 解析 JSON 字符串
            nodes = JSON.parse(nodesDataStr);
            console.log('Successfully parsed nodes:', nodes);
            console.log('Number of nodes:', nodes.length);
            
            // 验证节点数据
            if (!Array.isArray(nodes)) {
              console.error('Nodes data is not an array:', nodes);
              nodes = [];
            } else {
              // 检查每个节点是否有必要字段
              nodes = nodes.filter((node: any) => {
                if (!node || typeof node !== 'object') {
                  console.warn('Invalid node:', node);
                  return false;
                }
                if (!node.nid) {
                  console.warn('Node missing nid:', node);
                  return false;
                }
                return true;
              });
              console.log('Validated nodes count:', nodes.length);
            }
          } catch (parseError: any) {
            console.error('JSON parse error:', parseError);
            console.error('Failed to parse:', nodesDataStr);
            nodes = [];
          }
        } else {
          console.warn('No nodes data found in data-workflow-nodes attribute');
        }
      } catch (error: any) {
        console.error('Failed to parse workflow nodes:', error);
        console.error('Error stack:', error.stack);
        nodes = [];
      }

      if (nodes.length === 0) {
        console.warn('No nodes found, cannot render workflow viewer');
        $viewer.html('<p style="padding: 20px; text-align: center; color: #999;">暂无节点数据</p>');
        return;
      }

      ReactDOM.render(
        <WorkflowViewer workflowId={workflowId} initialNodes={nodes} />,
        $viewer[0]
      );
    }
  } catch (error: any) {
    console.error('Failed to initialize workflow viewer:', error);
  }

  // 执行工作流（手动执行）
  $('#execute-workflow-btn').on('click', async function() {
    const $btn = $(this);
    const workflowId = $btn.data('workflow-id');
    
    if (!confirm('确定要执行这个工作流吗？')) {
      return;
    }
    
    $btn.prop('disabled', true);
    try {
      const response = await request.post(`/workflow/${workflowId}/execute`, {
        triggerData: {},
      });
      
      if (response.success) {
        Notification.success('工作流执行成功');
      } else {
        Notification.error('工作流执行失败: ' + (response.error || '未知错误'));
      }
    } catch (error: any) {
      Notification.error('执行失败: ' + (error.message || '未知错误'));
    } finally {
      $btn.prop('disabled', false);
    }
  });

  // 按钮触发器
  $('.workflow-trigger-btn').on('click', async function() {
    const $btn = $(this);
    const workflowId = $btn.data('workflow-id');
    const requireConfirmation = $btn.data('require-confirmation') === true || $btn.data('require-confirmation') === 'true';
    const confirmationMessage = $btn.data('confirmation-message') || '确定要触发此工作流吗？';
    
    if (requireConfirmation) {
      if (!confirm(confirmationMessage)) {
        return;
      }
    }
    
    $btn.prop('disabled', true);
    const originalText = $btn.text();
    $btn.text('触发中...');
    
    try {
      const response = await request.post(`/workflow/${workflowId}/trigger`, {});
      
      if (response.success) {
        Notification.success('工作流触发成功');
      } else {
        Notification.error('工作流触发失败: ' + (response.error || '未知错误'));
      }
    } catch (error: any) {
      Notification.error('触发失败: ' + (error.message || '未知错误'));
    } finally {
      $btn.prop('disabled', false);
      $btn.text(originalText);
    }
  });
});

export default page;


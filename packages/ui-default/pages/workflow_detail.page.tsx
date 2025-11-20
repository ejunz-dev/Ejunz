import $ from 'jquery';
import React, { useMemo, useEffect, useCallback } from 'react';
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
  Handle,
  Position,
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
  const isButtonNode = data.nodeType === 'button';
  const originalNode = data.originalNode as WorkflowNode;
  const config = originalNode?.config || {};
  const buttonText = config.buttonText || '触发工作流';
  const buttonStyle = config.buttonStyle || 'primary';
  const requireConfirmation = config.requireConfirmation || false;
  const confirmationMessage = config.confirmationMessage || '确定要触发此工作流吗？';

  const handleButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到节点
    e.preventDefault(); // 阻止默认行为
    
    console.log('Button clicked in node:', originalNode);
    
    if (requireConfirmation) {
      if (!confirm(confirmationMessage)) {
        return;
      }
    }

    if (data.onTrigger) {
      console.log('Calling onTrigger for node:', originalNode.nid);
      data.onTrigger(originalNode);
    } else {
      console.warn('onTrigger not available in node data');
    }
  };
  
  const handleButtonMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止拖拽开始
  };
  
  const handleButtonMouseUp = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止拖拽结束
  };

  return (
    <div
      style={{
        padding: '10px 15px',
        background: '#fff',
        border: `2px solid ${color}`,
        borderRadius: '8px',
        minWidth: '150px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        position: 'relative',
      }}
    >
      {/* 输入连接点（顶部） */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: '#555',
          width: '12px',
          height: '12px',
          border: '2px solid #fff',
        }}
      />
      
      <div style={{ fontWeight: 'bold', marginBottom: '5px', fontSize: '14px', color: color }}>
        {data.label}
      </div>
      <div style={{ fontSize: '12px', color: '#666', marginBottom: isButtonNode ? '10px' : '0' }}>
        {data.nodeType}
      </div>
      
      {/* 如果是按钮节点，显示可点击的按钮 */}
      {isButtonNode && (
        <button
          onClick={handleButtonClick}
          onMouseDown={handleButtonMouseDown}
          onMouseUp={handleButtonMouseUp}
          style={{
            width: '100%',
            padding: '6px 12px',
            marginTop: '8px',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: '500',
            transition: 'all 0.2s',
            backgroundColor: buttonStyle === 'primary' ? '#2196f3' : 
                           buttonStyle === 'secondary' ? '#757575' :
                           buttonStyle === 'success' ? '#4caf50' :
                           buttonStyle === 'warning' ? '#ff9800' :
                           buttonStyle === 'danger' ? '#f44336' : '#2196f3',
            color: '#fff',
            pointerEvents: 'auto', // 确保按钮可以接收点击事件
            zIndex: 10, // 确保按钮在节点之上
            position: 'relative', // 确保 z-index 生效
          }}
          onMouseEnter={(e) => {
            e.stopPropagation();
            e.currentTarget.style.opacity = '0.8';
          }}
          onMouseLeave={(e) => {
            e.stopPropagation();
            e.currentTarget.style.opacity = '1';
          }}
        >
          {buttonText}
        </button>
      )}
      
      {/* 输出连接点（底部） */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: '#555',
          width: '12px',
          height: '12px',
          border: '2px solid #fff',
        }}
      />
    </div>
  );
};

const customNodeTypes: NodeTypes = {
  custom: CustomNode,
};

// 工作流可视化组件（只读）
function WorkflowViewer({ workflowId, initialNodes }: { workflowId: number; initialNodes: WorkflowNode[] }) {
  // 处理按钮节点触发
  const handleTrigger = useCallback(async (node: WorkflowNode) => {
    const config = node.config || {};
    const requireConfirmation = config.requireConfirmation || false;
    const confirmationMessage = config.confirmationMessage || '确定要触发此工作流吗？';

    if (requireConfirmation) {
      if (!confirm(confirmationMessage)) {
        return;
      }
    }

    try {
      const response = await request.post(`/workflow/${workflowId}/trigger`, {
        operation: 'trigger',
        nodeId: node.nid,
        triggerData: { source: 'button', nodeId: node.nid },
      });

      if (response.success) {
        Notification.success('工作流触发成功');
      } else {
        Notification.error('工作流触发失败: ' + (response.error || '未知错误'));
      }
    } catch (error: any) {
      Notification.error('触发失败: ' + (error.message || '未知错误'));
    }
  }, [workflowId]);

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
          onTrigger: handleTrigger, // 传递触发函数
        },
      } as Node;
    });
  }, [initialNodes, handleTrigger]);

  // 将 connections 转换为 ReactFlow 的 Edge 格式
  const initialFlowEdges = useMemo(() => {
    const edges: Edge[] = [];
    console.log('Building edges from nodes:', initialNodes);
    initialNodes.forEach((node) => {
      console.log(`Node ${node.nid} connections:`, node.connections);
      if (node.connections && Array.isArray(node.connections)) {
        node.connections.forEach((conn) => {
          if (conn && typeof conn === 'object' && conn.targetNodeId) {
            const edge: Edge = {
              id: `edge-${node.nid}-${conn.targetNodeId}`,
              source: `node-${node.nid}`,
              target: `node-${conn.targetNodeId}`,
              type: 'smoothstep',
              animated: true,
              markerEnd: {
                type: MarkerType.ArrowClosed,
              },
              label: conn.condition || '',
            };
            edges.push(edge);
            console.log(`Created edge: ${edge.id} from ${edge.source} to ${edge.target}`);
          }
        });
      }
    });
    console.log(`Total edges created: ${edges.length}`, edges);
    return edges;
  }, [initialNodes]);

  // 使用 React Flow 的状态管理
  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlowEdges);

  // 当 initialNodes 变化时更新节点和边
  React.useEffect(() => {
    console.log('Updating nodes and edges:', {
      nodesCount: initialFlowNodes.length,
      edgesCount: initialFlowEdges.length,
      edges: initialFlowEdges
    });
    setNodes(initialFlowNodes);
    setEdges(initialFlowEdges);
  }, [initialFlowNodes, initialFlowEdges, setNodes, setEdges]);
  
  // 调试：监听 edges 变化
  React.useEffect(() => {
    console.log('Current edges state:', edges);
  }, [edges]);

  // 处理节点点击事件，但允许按钮点击
  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    // 如果点击的是按钮节点内的按钮，不处理节点点击
    const target = event.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.closest('button')) {
      console.log('Button click detected, ignoring node click');
      return; // 让按钮的 onClick 处理
    }
    console.log('Node clicked:', node.id);
  }, []);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={customNodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={[1, 2]} // 只在鼠标中键和右键时拖拽，左键用于点击
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
              // 检查每个节点是否有必要字段，并确保 connections 存在
              nodes = nodes.map((node: any) => {
                if (!node || typeof node !== 'object') {
                  console.warn('Invalid node:', node);
                  return null;
                }
                if (!node.nid) {
                  console.warn('Node missing nid:', node);
                  return null;
                }
                // 确保 connections 是数组
                if (!Array.isArray(node.connections)) {
                  console.warn(`Node ${node.nid} connections is not an array:`, node.connections);
                  node.connections = [];
                }
                console.log(`Node ${node.nid} has ${node.connections?.length || 0} connections:`, node.connections);
                return node;
              }).filter((node: any) => node !== null);
              console.log('Validated nodes count:', nodes.length);
              console.log('All nodes with connections:', nodes.map((n: any) => ({
                nid: n.nid,
                name: n.name,
                connections: n.connections
              })));
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
  $(document).on('click', '.workflow-trigger-btn', async function() {
    const $btn = $(this);
    const workflowId = $btn.data('workflow-id');
    const nodeId = $btn.data('node-id');
    const requireConfirmation = $btn.data('require-confirmation') === true || $btn.data('require-confirmation') === 'true';
    const confirmationMessage = $btn.data('confirmation-message') || '确定要触发此工作流吗？';
    
    console.log('Button trigger clicked:', { workflowId, nodeId, requireConfirmation });
    
    if (!workflowId) {
      Notification.error('工作流ID不存在');
      return;
    }
    
    if (requireConfirmation) {
      if (!confirm(confirmationMessage)) {
        return;
      }
    }
    
    $btn.prop('disabled', true);
    const originalText = $btn.text();
    $btn.text('触发中...');
    
    try {
      const response = await request.post(`/workflow/${workflowId}/trigger`, {
        operation: 'trigger',
        nodeId: nodeId,
        triggerData: { source: 'button', nodeId: nodeId },
      });
      
      console.log('Trigger response:', response);
      
      if (response.success) {
        Notification.success('工作流触发成功');
      } else {
        Notification.error('工作流触发失败: ' + (response.error || '未知错误'));
      }
    } catch (error: any) {
      console.error('Trigger error:', error);
      Notification.error('触发失败: ' + (error.message || '未知错误'));
    } finally {
      $btn.prop('disabled', false);
      $btn.text(originalText);
    }
  });
});

export default page;


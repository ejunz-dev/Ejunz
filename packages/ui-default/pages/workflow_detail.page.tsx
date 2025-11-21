import $ from 'jquery';
import React, { useMemo, useEffect, useCallback, useState, useRef } from 'react';
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

// 格式化时间显示（秒转换为可读格式）
const formatTime = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}秒`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${minutes}分${secs}秒` : `${minutes}分钟`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  } else {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  }
};

// 自定义节点组件（只读模式，支持实时状态显示）
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
  const isTimerNode = data.nodeType === 'timer';
  const originalNode = data.originalNode as WorkflowNode;
  const config = originalNode?.config || {};
  const buttonText = config.buttonText || '触发工作流';
  const buttonStyle = config.buttonStyle || 'primary';
  const requireConfirmation = config.requireConfirmation || false;
  const confirmationMessage = config.confirmationMessage || '确定要触发此工作流吗？';
  
  // 获取实时状态
  const timerCountdown = data.timerCountdown;
  const workflowEnabled = data.workflowEnabled;
  const formatTime = data.formatTime || ((seconds: number) => {
    // 如果没有传递 formatTime，使用默认实现
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
      return `${hours}时${minutes}分${secs}秒`;
    } else if (minutes > 0) {
      return `${minutes}分${secs}秒`;
    } else {
      return `${secs}秒`;
    }
  });

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
      {/* 输入连接点（左侧） */}
      <Handle
        type="target"
        position={Position.Left}
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
      <div style={{ fontSize: '12px', color: '#666', marginBottom: (isButtonNode || isTimerNode) ? '10px' : '0' }}>
        {data.nodeType}
      </div>
      
      {/* 工作流状态指示器 */}
      {workflowEnabled !== undefined && (
        <div style={{ 
          fontSize: '10px', 
          padding: '2px 6px', 
          borderRadius: '3px',
          backgroundColor: workflowEnabled ? '#e8f5e9' : '#ffebee',
          color: workflowEnabled ? '#2e7d32' : '#c62828',
          marginBottom: '5px',
          display: 'inline-block',
        }}>
          {workflowEnabled ? '✓ 已激活' : '✗ 已关闭'}
        </div>
      )}
      
      {/* 如果是定时器节点，显示倒计时 */}
      {isTimerNode && (
        <div style={{
          width: '100%',
          padding: '6px',
          marginTop: '8px',
          border: '1px solid #4caf50',
          borderRadius: '4px',
          backgroundColor: '#f1f8f4',
          textAlign: 'center',
        }}>
          {workflowEnabled && timerCountdown !== undefined && timerCountdown > 0 ? (
            <>
              <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#2e7d32' }}>
                {formatTime(timerCountdown)}
              </div>
              <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>下次触发</div>
            </>
          ) : (
            <div style={{ fontSize: '12px', color: '#999' }}>
              {workflowEnabled ? '等待定时器注册...' : '工作流已关闭'}
            </div>
          )}
        </div>
      )}
      
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
      
      {/* 输出连接点（右侧） */}
      <Handle
        type="source"
        position={Position.Right}
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

// 工作流可视化组件（只读，支持实时状态显示）
function WorkflowViewer({ workflowId, initialNodes, enabled: initialEnabled }: { workflowId: number; initialNodes: WorkflowNode[]; enabled: boolean }) {
  const [workflowEnabled, setWorkflowEnabled] = useState(initialEnabled);
  const [timerCountdowns, setTimerCountdowns] = useState<Record<number, number>>({});
  const timerIntervalsRef = useRef<Record<number, NodeJS.Timeout>>({});
  // 存储定时器的 executeAfter 时间（从后端同步）
  const timerExecuteAfterRef = useRef<Record<number, Date>>({});
  
  // 更新定时器状态（从 WebSocket 接收）
  const updateTimerStatus = useCallback((timers: Record<number, { executeAfter: string; interval?: [number, string] }>) => {
    console.log('updateTimerStatus called:', { workflowEnabled, timers, timerNodes: initialNodes.filter(n => n.nodeType === 'timer') });
    
    if (!workflowEnabled) {
      // 如果工作流未启用，清除所有倒计时
      console.log('Workflow not enabled, clearing timers');
      setTimerCountdowns({});
      Object.values(timerIntervalsRef.current).forEach(interval => clearInterval(interval));
      timerIntervalsRef.current = {};
      timerExecuteAfterRef.current = {};
      return;
    }
    
    // 获取工作流定时器节点
    const timerNodes = initialNodes.filter(n => n.nodeType === 'timer');
    console.log('Timer nodes found:', timerNodes.map(n => ({ nid: n.nid, name: n.name })));
    
    timerNodes.forEach(node => {
      const timer = timers[node.nid];
      console.log(`Processing timer node ${node.nid}:`, timer);
      
      if (timer && timer.executeAfter) {
        // 更新 executeAfter 时间
        const executeAfter = new Date(timer.executeAfter);
        timerExecuteAfterRef.current[node.nid] = executeAfter;
        
        // 计算倒计时（秒）
        const now = new Date();
        const diffSeconds = Math.max(0, Math.floor((executeAfter.getTime() - now.getTime()) / 1000));
        
        console.log(`Timer ${node.nid}: executeAfter=${executeAfter.toISOString()}, now=${now.toISOString()}, diffSeconds=${diffSeconds}`);
        
        // 更新倒计时
        setTimerCountdowns(prev => {
          const newState = {
            ...prev,
            [node.nid]: diffSeconds,
          };
          console.log('Updated timer countdowns:', newState);
          return newState;
        });
        
        // 如果还没有为这个节点设置定时器，启动它
        if (!timerIntervalsRef.current[node.nid]) {
          console.log(`Starting countdown interval for node ${node.nid}`);
          // 启动倒计时更新（每秒更新一次）
          timerIntervalsRef.current[node.nid] = setInterval(() => {
            const executeAfter = timerExecuteAfterRef.current[node.nid];
            if (executeAfter) {
              const now = new Date();
              const diffSeconds = Math.max(0, Math.floor((executeAfter.getTime() - now.getTime()) / 1000));
              
              setTimerCountdowns(prev => ({
                ...prev,
                [node.nid]: diffSeconds,
              }));
            }
          }, 1000);
        }
      } else {
        console.log(`No timer found for node ${node.nid}, clearing countdown`);
        // 如果没有定时器记录，清除倒计时
        if (timerIntervalsRef.current[node.nid]) {
          clearInterval(timerIntervalsRef.current[node.nid]);
          delete timerIntervalsRef.current[node.nid];
        }
        delete timerExecuteAfterRef.current[node.nid];
        setTimerCountdowns(prev => {
          const newState = { ...prev };
          delete newState[node.nid];
          return newState;
        });
      }
    });
  }, [workflowEnabled, initialNodes]);
  
  // 监听工作流状态变化（通过页面上的按钮状态）
  useEffect(() => {
    const checkWorkflowStatus = () => {
      const $btn = $('#toggle-workflow-btn');
      if ($btn.length) {
        const enabled = $btn.data('enabled') === true || $btn.data('enabled') === 'true';
        setWorkflowEnabled(enabled);
      }
    };
    
    // 每2秒检查一次工作流状态（从按钮状态获取）
    const statusInterval = setInterval(checkWorkflowStatus, 2000);
    
    // 监听按钮点击事件来更新状态
    $(document).on('workflow:toggled', (event: any, enabled: boolean) => {
      setWorkflowEnabled(enabled);
    });
    
    return () => {
      clearInterval(statusInterval);
      $(document).off('workflow:toggled');
    };
  }, []);
  
  // WebSocket 连接（用于实时接收定时器状态）
  useEffect(() => {
    const $viewer = $('#workflow-viewer');
    const socketUrl = $viewer.data('socket-url') as string;
    
    if (!socketUrl) {
      console.warn('No socket URL provided, timer status updates will not be available');
      return;
    }
    
    let sock: any = null;
    
    // 动态导入 WebSocket
    import('../components/socket').then(({ default: WebSocket }) => {
      const UiContext = (window as any).UiContext;
      // 构建完整的 WebSocket URL
      // socketUrl 应该是相对路径，如 "workflow/3/ws"
      // ws_prefix 通常是 "/d/{domainId}/" 或类似的格式
      let wsUrl: string;
      if (socketUrl.startsWith('http://') || socketUrl.startsWith('https://') || socketUrl.startsWith('ws://') || socketUrl.startsWith('wss://')) {
        // 已经是完整 URL
        wsUrl = socketUrl;
      } else {
        // 相对路径，需要添加 ws_prefix
        const prefix = UiContext.ws_prefix || '';
        const path = socketUrl.startsWith('/') ? socketUrl : '/' + socketUrl;
        wsUrl = prefix + path;
      }
      console.log('Connecting to WebSocket:', wsUrl, 'socketUrl:', socketUrl, 'ws_prefix:', UiContext.ws_prefix);
      sock = new WebSocket(wsUrl, false, true);
      
      sock.onopen = () => {
        console.log('Workflow WebSocket connected');
      };
      
      sock.onmessage = (_: any, data: string) => {
        try {
          const msg = JSON.parse(data);
          console.log('WebSocket message received:', msg);
          if (msg.type === 'timer_status' && msg.timers) {
            console.log('Updating timer status:', msg.timers);
            // 更新定时器状态
            updateTimerStatus(msg.timers);
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };
      
      sock.onclose = () => {
        console.log('Workflow WebSocket closed');
      };
    }).catch((error) => {
      console.error('Failed to load WebSocket:', error);
    });
    
    return () => {
      // 清理所有定时器
      Object.values(timerIntervalsRef.current).forEach(interval => clearInterval(interval));
      timerIntervalsRef.current = {};
      if (sock) {
        try {
          sock.close();
        } catch (e) {
          // ignore
        }
      }
    };
  }, [updateTimerStatus]);
  
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
        : { x: 100 + index * 250, y: 200 };
      
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
          timerCountdown: timerCountdowns[node.nid], // 传递倒计时
          workflowEnabled: workflowEnabled, // 传递工作流启用状态
          formatTime: formatTime, // 传递格式化时间函数
        },
      } as Node;
    });
  }, [initialNodes, handleTrigger, timerCountdowns, workflowEnabled]);

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

  // 当状态变化时更新节点数据
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const nodeId = parseInt(n.id.replace('node-', ''));
        return {
          ...n,
          data: {
            ...n.data,
            timerCountdown: timerCountdowns[nodeId],
            workflowEnabled: workflowEnabled,
            formatTime: formatTime, // 确保 formatTime 始终传递
          },
        };
      })
    );
  }, [timerCountdowns, workflowEnabled, setNodes]);
  
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

      const workflowEnabled = $viewer.data('workflow-enabled') === true || $viewer.data('workflow-enabled') === 'true';
      
      ReactDOM.render(
        <WorkflowViewer workflowId={workflowId} initialNodes={nodes} enabled={workflowEnabled} />,
        $viewer[0]
      );
    }
  } catch (error: any) {
    console.error('Failed to initialize workflow viewer:', error);
  }

  // 切换工作流启用状态
  $('#toggle-workflow-btn').on('click', async function() {
    const $btn = $(this);
    const workflowId = $btn.data('workflow-id');
    const currentEnabled = $btn.data('enabled') === true || $btn.data('enabled') === 'true';
    
    $btn.prop('disabled', true);
    const originalText = $btn.text();
    $btn.text('处理中...');
    
    try {
      const response = await request.post(`/workflow/${workflowId}/toggle`, {
        operation: 'toggle',
      });
      
      if (response.success) {
        const newEnabled = response.enabled;
        $btn.data('enabled', newEnabled);
        
        if (newEnabled) {
          $btn.removeClass('success').addClass('danger').text('关闭工作流');
          Notification.success('工作流已激活');
        } else {
          $btn.removeClass('danger').addClass('success').text('激活工作流');
          Notification.success('工作流已关闭');
        }
        
        // 更新页面上的状态显示
        $('.workflow-enabled-badge, .workflow-disabled-badge').remove();
        if (newEnabled) {
          $('.section__action').append('<span class="workflow-enabled-badge">已启用</span>');
        } else {
          $('.section__action').append('<span class="workflow-disabled-badge">已禁用</span>');
        }
        
        // 触发自定义事件通知可视化组件
        $(document).trigger('workflow:toggled', [newEnabled]);
      } else {
        Notification.error('切换失败: ' + (response.error || '未知错误'));
      }
    } catch (error: any) {
      Notification.error('切换失败: ' + (error.message || '未知错误'));
    } finally {
      $btn.prop('disabled', false);
    }
  });

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


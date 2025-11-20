import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import { ActionDialog } from 'vj/components/dialog';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  Connection,
  addEdge,
  useNodesState,
  useEdgesState,
  MarkerType,
  NodeTypes,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlowInstance,
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

interface NodeType {
  type: string;
  nodeType: string;
  name: string;
  description: string;
  configSchema: Record<string, any>;
}

// 自定义节点组件
const CustomNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const isButtonNode = data.nodeType === 'button';
  const isTimerNode = data.nodeType === 'timer';
  const originalNode = data.originalNode as WorkflowNode;
  const config = originalNode?.config || {};
  const buttonText = config.buttonText || '触发工作流';
  const buttonStyle = config.buttonStyle || 'primary';
  const requireConfirmation = config.requireConfirmation || false;
  const confirmationMessage = config.confirmationMessage || '确定要触发此工作流吗？';

  const handleButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到节点
    e.preventDefault(); // 阻止默认行为
    
    if (requireConfirmation) {
      if (!confirm(confirmationMessage)) {
        return;
      }
    }

    if (data.onTrigger) {
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

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到节点
    e.preventDefault(); // 阻止默认行为
    
    if (data.onDelete) {
      data.onDelete(originalNode);
    }
  };

  return (
    <div
      style={{
        padding: '10px 15px',
        background: selected ? '#e3f2fd' : '#fff',
        border: `2px solid ${selected ? '#1976d2' : '#2196f3'}`,
        borderRadius: '8px',
        minWidth: '150px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        cursor: 'move',
        position: 'relative',
      }}
    >
      {/* 删除按钮 */}
      <button
        onClick={handleDeleteClick}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: '5px',
          right: '5px',
          width: '20px',
          height: '20px',
          padding: 0,
          border: 'none',
          borderRadius: '50%',
          background: '#f44336',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 'bold',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
          opacity: selected ? 1 : 0.7,
          transition: 'all 0.2s',
        }}
        onMouseEnter={(e) => {
          e.stopPropagation();
          e.currentTarget.style.opacity = '1';
          e.currentTarget.style.transform = 'scale(1.1)';
        }}
        onMouseLeave={(e) => {
          e.stopPropagation();
          e.currentTarget.style.opacity = selected ? '1' : '0.7';
          e.currentTarget.style.transform = 'scale(1)';
        }}
        title="删除节点"
      >
        ×
      </button>
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
      
      <div style={{ fontWeight: 'bold', marginBottom: '5px', fontSize: '14px' }}>
        {data.label}
      </div>
      <div style={{ fontSize: '12px', color: '#666', marginBottom: (isButtonNode || isTimerNode) ? '10px' : '0' }}>
        {data.nodeType}
      </div>
      
      {/* 如果是定时器节点，显示倒计时和测试按钮 */}
      {isTimerNode && (
        <>
          {data.timerCountdown !== undefined && data.timerCountdown > 0 ? (
            <div style={{
              width: '100%',
              padding: '8px',
              marginTop: '8px',
              border: '1px solid #4caf50',
              borderRadius: '4px',
              backgroundColor: '#f1f8f4',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#2e7d32', marginBottom: '4px' }}>
                {data.formatTime ? data.formatTime(data.timerCountdown) : `${data.timerCountdown}秒`}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  if (data.onStopTimer && originalNode) {
                    data.onStopTimer(originalNode.nid);
                  }
                }}
                onMouseDown={handleButtonMouseDown}
                onMouseUp={handleButtonMouseUp}
                style={{
                  padding: '4px 8px',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  backgroundColor: '#f44336',
                  color: '#fff',
                  pointerEvents: 'auto',
                }}
                title="停止倒计时"
              >
                停止
              </button>
            </div>
          ) : (
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
                backgroundColor: '#4caf50',
                color: '#fff',
                pointerEvents: 'auto',
                zIndex: 10,
                position: 'relative',
              }}
              onMouseEnter={(e) => {
                e.stopPropagation();
                e.currentTarget.style.opacity = '0.8';
              }}
              onMouseLeave={(e) => {
                e.stopPropagation();
                e.currentTarget.style.opacity = '1';
              }}
              title="开始测试定时器触发"
            >
              测试触发
            </button>
          )}
        </>
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

// 节点面板组件
const NodePalette = ({ 
  nodeTypes, 
  onDragStart 
}: { 
  nodeTypes: { trigger: NodeType[]; action: NodeType[] }; 
  onDragStart: (nodeType: NodeType, category: string) => void;
}) => {
  return (
    <div
      style={{
        width: '250px',
        height: '100%',
        background: '#f5f5f5',
        borderRight: '1px solid #ddd',
        padding: '15px',
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '15px', fontSize: '16px', fontWeight: 'bold' }}>
        节点面板
      </h3>
      
      {/* 触发器节点 */}
      <div style={{ marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>
          触发器
        </h4>
        {nodeTypes.trigger && nodeTypes.trigger.length > 0 ? (
          nodeTypes.trigger.map((nodeType) => (
            <div
              key={nodeType.nodeType}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/reactflow', JSON.stringify({ nodeType, category: 'trigger' }));
                onDragStart(nodeType, 'trigger');
              }}
              style={{
                padding: '10px',
                marginBottom: '8px',
                background: '#fff',
                border: '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'grab',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f0f0f0';
                e.currentTarget.style.borderColor = '#2196f3';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#fff';
                e.currentTarget.style.borderColor = '#ddd';
              }}
            >
              <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '4px' }}>
                {nodeType.name}
              </div>
              <div style={{ fontSize: '11px', color: '#888' }}>
                {nodeType.description}
              </div>
            </div>
          ))
        ) : (
          <div style={{ fontSize: '12px', color: '#999', fontStyle: 'italic' }}>暂无触发器节点</div>
        )}
      </div>

      {/* 执行节点 */}
      <div>
        <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>
          执行
        </h4>
        {nodeTypes.action && nodeTypes.action.length > 0 ? (
          nodeTypes.action.map((nodeType) => (
            <div
              key={nodeType.nodeType}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/reactflow', JSON.stringify({ nodeType, category: 'action' }));
                onDragStart(nodeType, 'action');
              }}
              style={{
                padding: '10px',
                marginBottom: '8px',
                background: '#fff',
                border: '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'grab',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f0f0f0';
                e.currentTarget.style.borderColor = '#2196f3';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#fff';
                e.currentTarget.style.borderColor = '#ddd';
              }}
            >
              <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '4px' }}>
                {nodeType.name}
              </div>
              <div style={{ fontSize: '11px', color: '#888' }}>
                {nodeType.description}
              </div>
            </div>
          ))
        ) : (
          <div style={{ fontSize: '12px', color: '#999', fontStyle: 'italic' }}>暂无执行节点</div>
        )}
      </div>
    </div>
  );
};

let globalEditorRef: any = null;

function WorkflowEditor({ workflowId, initialNodes }: { workflowId: number; initialNodes: WorkflowNode[] }) {
  const [nodeTypesData, setNodeTypesData] = useState<{ trigger: NodeType[]; action: NodeType[] }>({ trigger: [], action: [] });
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  // 定时器倒计时状态：{ nodeId: { countdown: number, interval: number } }
  const [timerCountdowns, setTimerCountdowns] = useState<Record<number, { countdown: number; interval: number }>>({});
  const timerIntervalsRef = useRef<Record<number, NodeJS.Timeout>>({});

  // 计算定时器间隔（秒）
  const calculateTimerInterval = useCallback((config: Record<string, any>): number => {
    const interval = config.interval || 'day';
    const intervalValue = config.intervalValue || 1;
    
    switch (interval) {
      case 'minute':
        return intervalValue * 60; // 转换为秒
      case 'hour':
        return intervalValue * 60 * 60;
      case 'day':
        return intervalValue * 24 * 60 * 60;
      case 'week':
        return intervalValue * 7 * 24 * 60 * 60;
      case 'month':
        return intervalValue * 30 * 24 * 60 * 60; // 简化处理，一个月按30天计算
      default:
        return 24 * 60 * 60; // 默认1天
    }
  }, []);

  // 启动定时器倒计时
  const startTimerCountdown = useCallback((node: WorkflowNode) => {
    const config = node.config || {};
    const intervalSeconds = calculateTimerInterval(config);
    
    // 清除旧的定时器
    if (timerIntervalsRef.current[node.nid]) {
      clearInterval(timerIntervalsRef.current[node.nid]);
    }
    
    // 设置初始倒计时
    setTimerCountdowns(prev => ({
      ...prev,
      [node.nid]: { countdown: intervalSeconds, interval: intervalSeconds },
    }));
    
    // 启动倒计时
    timerIntervalsRef.current[node.nid] = setInterval(() => {
      setTimerCountdowns(prev => {
        const current = prev[node.nid];
        if (!current) return prev;
        
        const newCountdown = current.countdown - 1;
        
        if (newCountdown <= 0) {
          // 倒计时结束，触发工作流
          triggerTimerWorkflow(node, config, intervalSeconds);
          // 重置倒计时
          return {
            ...prev,
            [node.nid]: { countdown: current.interval, interval: current.interval },
          };
        }
        
        return {
          ...prev,
          [node.nid]: { countdown: newCountdown, interval: current.interval },
        };
      });
    }, 1000);
  }, [calculateTimerInterval]);

  // 停止定时器倒计时
  const stopTimerCountdown = useCallback((nodeId: number) => {
    if (timerIntervalsRef.current[nodeId]) {
      clearInterval(timerIntervalsRef.current[nodeId]);
      delete timerIntervalsRef.current[nodeId];
    }
    setTimerCountdowns(prev => {
      const newState = { ...prev };
      delete newState[nodeId];
      return newState;
    });
  }, []);

  // 触发定时器工作流
  const triggerTimerWorkflow = useCallback(async (node: WorkflowNode, config: Record<string, any>, intervalSeconds: number) => {
    try {
      const response = await request.post(`/workflow/${workflowId}/trigger`, {
        operation: 'trigger',
        nodeId: node.nid,
        triggerType: 'timer',
        triggerData: { 
          source: 'timer', 
          nodeId: node.nid,
          ...(config.triggerData || {}),
        },
      });

      if (response.success) {
        Notification.success(`定时器触发成功 (间隔: ${formatTime(intervalSeconds)})`);
      } else {
        Notification.error('定时器触发失败: ' + (response.error || '未知错误'));
      }
    } catch (error: any) {
      Notification.error('定时器触发失败: ' + (error.message || '未知错误'));
    }
  }, [workflowId]);

  // 格式化时间显示（秒转换为可读格式）
  const formatTime = useCallback((seconds: number): string => {
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
  }, []);

  // 处理节点触发（按钮或定时器）
  const handleTrigger = useCallback(async (node: WorkflowNode) => {
    const config = node.config || {};
    const isButtonNode = node.nodeType === 'button';
    const isTimerNode = node.nodeType === 'timer';
    
    // 按钮节点可能需要确认
    if (isButtonNode) {
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
          triggerType: 'button',
          triggerData: { 
            source: 'button', 
            nodeId: node.nid,
          },
        });

        if (response.success) {
          Notification.success('工作流触发成功');
        } else {
          Notification.error('工作流触发失败: ' + (response.error || '未知错误'));
        }
      } catch (error: any) {
        Notification.error('触发失败: ' + (error.message || '未知错误'));
      }
    } else if (isTimerNode) {
      // 定时器节点：启动倒计时循环
      startTimerCountdown(node);
    }
  }, [workflowId, startTimerCountdown]);

  // 清理定时器
  useEffect(() => {
    return () => {
      Object.values(timerIntervalsRef.current).forEach(interval => {
        clearInterval(interval);
      });
    };
  }, []);

  // 将 WorkflowNode 转换为 ReactFlow 的 Node 格式
  const initialFlowNodes = useMemo(() => {
    return initialNodes.map((node) => ({
      id: `node-${node.nid}`,
      type: 'custom',
      position: node.position,
        data: {
          label: node.name,
          nodeType: node.nodeType,
          originalNode: node,
          onTrigger: handleTrigger, // 传递触发函数
          onStopTimer: stopTimerCountdown, // 传递停止定时器函数
          timerCountdown: timerCountdowns[node.nid]?.countdown, // 传递倒计时
          formatTime: formatTime, // 传递格式化时间函数
        },
    })) as Node[];
  }, [initialNodes, handleTrigger, stopTimerCountdown, timerCountdowns, formatTime]);

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

  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlowEdges);

  // 处理删除节点（需要在 setNodes 和 setEdges 声明之后）
  const handleDeleteNode = useCallback(async (node: WorkflowNode) => {
    if (!confirm(`确定要删除节点"${node.name}"吗？这将同时删除所有相关的连接。`)) {
      return;
    }

    try {
      // 如果是定时器节点，先停止倒计时
      if (node.nodeType === 'timer') {
        stopTimerCountdown(node.nid);
      }

      await request.post(`/workflow/${workflowId}/node/${node.nid}/delete`, {
        operation: 'delete',
      });
      
      // 从画布中移除节点
      setNodes((nds) => nds.filter((n) => n.id !== `node-${node.nid}`));
      
      // 删除所有与该节点相关的连接
      setEdges((eds) => 
        eds.filter((e) => 
          e.source !== `node-${node.nid}` && e.target !== `node-${node.nid}`
        )
      );

      Notification.success('节点已删除');
    } catch (error: any) {
      Notification.error('删除节点失败: ' + (error.message || '未知错误'));
    }
  }, [workflowId, setNodes, setEdges, stopTimerCountdown]);

  // 更新节点数据，添加 onDelete、onStopTimer、timerCountdown 和 formatTime 函数
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const nodeId = parseInt(n.id.replace('node-', ''));
        return {
          ...n,
          data: {
            ...n.data,
            onDelete: handleDeleteNode,
            onStopTimer: stopTimerCountdown,
            timerCountdown: timerCountdowns[nodeId]?.countdown,
            formatTime: formatTime,
          },
        };
      })
    );
  }, [handleDeleteNode, stopTimerCountdown, timerCountdowns, formatTime, setNodes]);

  useEffect(() => {
    loadNodeTypes();
  }, []);

  const loadNodeTypes = async () => {
    try {
      const response = await request.get('/workflow/node-types');
      const nodeTypes = response.nodeTypes || { trigger: [], action: [] };
      setNodeTypesData(nodeTypes);
    } catch (error: any) {
      Notification.error('加载节点类型失败: ' + (error.message || '未知错误'));
    }
  };

  // 处理从面板拖拽节点到画布
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!reactFlowBounds || !reactFlowInstance) {
        return;
      }

      const data = event.dataTransfer.getData('application/reactflow');
      if (!data) {
        return;
      }

      try {
        const { nodeType, category } = JSON.parse(data);
        const position = reactFlowInstance.screenToFlowPosition({
          x: event.clientX - reactFlowBounds.left,
          y: event.clientY - reactFlowBounds.top,
        });

        // 创建新节点
        const newNode: Partial<WorkflowNode> = {
          name: nodeType.name,
          nodeType: nodeType.nodeType,
          type: category,
          position,
          config: {},
          connections: [],
        };

        // 保存到后端
        const response = await request.post(`/workflow/${workflowId}/node`, {
          operation: 'create',
          ...newNode,
        });
        const createdNode = response.node;

        // 添加到画布
        const newFlowNode: Node = {
          id: `node-${createdNode.nid}`,
          type: 'custom',
          position,
          data: {
            label: createdNode.name,
            nodeType: createdNode.nodeType,
            originalNode: createdNode,
            onTrigger: handleTrigger, // 传递触发函数
            onDelete: handleDeleteNode, // 传递删除函数
            onStopTimer: stopTimerCountdown, // 传递停止定时器函数
            timerCountdown: timerCountdowns[createdNode.nid]?.countdown, // 传递倒计时
            formatTime: formatTime, // 传递格式化时间函数
          },
        };

        setNodes((nds) => [...nds, newFlowNode]);
        Notification.success('节点已添加');
      } catch (error: any) {
        Notification.error('添加节点失败: ' + (error.message || '未知错误'));
      }
    },
    [reactFlowInstance, workflowId, setNodes, handleTrigger, handleDeleteNode, stopTimerCountdown, timerCountdowns, formatTime]
  );

  // 渲染配置表单（与 workflow_edit.page.tsx 中的相同）
  const renderConfigForm = async ($container: JQuery, nodeType: any, category: string, currentConfig: Record<string, any> = {}, originalNode?: WorkflowNode) => {
    $container.empty();
    const schema = nodeType.configSchema || {};

    if (nodeType.nodeType === 'object_action') {
      const nodesResponse = await request.get('/workflow/nodes');
      const nodesList = nodesResponse.nodes || [];
      
      $container.append(`
        <div style="margin-bottom: 15px;">
          <label>
            选择节点:
            <select name="nodeId" class="textbox" id="object-node-select" style="width: 100%;" required>
              <option value="">请选择节点</option>
              ${nodesList.map((n: any) => `<option value="${n.nid}" ${currentConfig.nodeId === n.nid ? 'selected' : ''}>${n.name}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            选择设备:
            <select name="deviceId" class="textbox" id="object-device-select" style="width: 100%;" required>
              <option value="">请先选择节点</option>
            </select>
          </label>
        </div>
      `);

      $container.find('#object-node-select').on('change', async function() {
        const nodeId = $(this).val() as string;
        const $deviceSelect = $container.find('#object-device-select');
        $deviceSelect.html('<option value="">加载中...</option>');
        
        if (nodeId) {
          try {
            const devicesResponse = await request.get(`/workflow/devices?nodeId=${nodeId}`);
            const devicesList = devicesResponse.devices || [];
            $deviceSelect.html(
              '<option value="">请选择设备</option>' +
              devicesList.map((d: any) => `<option value="${d.deviceId}" ${currentConfig.deviceId === d.deviceId ? 'selected' : ''}>${d.name} (${d.type})</option>`).join('')
            );
          } catch (error: any) {
            $deviceSelect.html('<option value="">加载失败</option>');
            Notification.error('加载设备列表失败: ' + error.message);
          }
        } else {
          $deviceSelect.html('<option value="">请先选择节点</option>');
        }
      });

      if (currentConfig.nodeId) {
        $container.find('#object-node-select').trigger('change');
      }

      $container.append(`
        <div style="margin-bottom: 15px;">
          <label>
            操作类型:
            <select name="action" class="textbox" style="width: 100%;" required>
              <option value="on" ${currentConfig.action === 'on' ? 'selected' : ''}>开启</option>
              <option value="off" ${currentConfig.action === 'off' ? 'selected' : ''}>关闭</option>
              <option value="toggle" ${currentConfig.action === 'toggle' ? 'selected' : ''}>切换</option>
              <option value="set" ${currentConfig.action === 'set' ? 'selected' : ''}>设置</option>
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            属性名（可选，如 on, brightness）:
            <input type="text" name="property" class="textbox" placeholder="属性名" value="${currentConfig.property || ''}" />
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            设置值（当操作类型为"设置"时）:
            <input type="text" name="value" class="textbox" placeholder="设置值" value="${currentConfig.value || ''}" />
          </label>
        </div>
      `);
    } else if (nodeType.nodeType === 'agent_action') {
      const agentsResponse = await request.get('/workflow/agents');
      const agentsList = agentsResponse.agents || [];
      
      $container.append(`
        <div style="margin-bottom: 15px;">
          <label>
            选择Agent:
            <select name="agentId" class="textbox" style="width: 100%;" required>
              <option value="">请选择Agent</option>
              ${agentsList.map((a: any) => `<option value="${a.aid}" ${currentConfig.agentId === a.aid ? 'selected' : ''}>${a.name}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            操作类型:
            <select name="action" class="textbox" style="width: 100%;" required>
              <option value="message" ${currentConfig.action === 'message' ? 'selected' : ''}>发送私信</option>
              <option value="generate" ${currentConfig.action === 'generate' ? 'selected' : ''}>生成内容</option>
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            提示词（支持 \${variable} 变量）:
            <textarea name="prompt" class="textbox" rows="4" style="width: 100%;" placeholder="输入提示词..." required>${currentConfig.prompt || ''}</textarea>
          </label>
        </div>
        <div style="margin-bottom: 15px;" id="agent-user-select-container">
          <label>
            目标用户ID（当操作类型为"发送私信"时）:
            <input type="number" name="userId" class="textbox" placeholder="用户ID" value="${currentConfig.userId || ''}" />
          </label>
        </div>
      `);

      $container.find('select[name="action"]').on('change', function() {
        const action = $(this).val();
        const $userContainer = $container.find('#agent-user-select-container');
        if (action === 'message') {
          $userContainer.show();
        } else {
          $userContainer.hide();
        }
      });

      if (currentConfig.action !== 'message') {
        $container.find('#agent-user-select-container').hide();
      }
    } else {
      for (const [key, field] of Object.entries(schema)) {
        const fieldConfig = field as any;
        const currentValue = currentConfig[key] !== undefined ? currentConfig[key] : fieldConfig.default;
        let inputHtml = '';

        if (fieldConfig.enum) {
          // 为 interval 字段提供中文标签
          const intervalLabels: Record<string, string> = {
            'minute': '每分钟',
            'hour': '每小时',
            'day': '每天',
            'week': '每周',
            'month': '每月',
          };
          const getLabel = (opt: any) => {
            if (key === 'interval' && intervalLabels[opt]) {
              return intervalLabels[opt];
            }
            return opt;
          };
          inputHtml = `
            <select name="${key}" class="textbox" style="width: 100%;">
              ${fieldConfig.enum.map((opt: any) => `<option value="${opt}" ${currentValue === opt ? 'selected' : ''}>${getLabel(opt)}</option>`).join('')}
            </select>
          `;
        } else if (fieldConfig.type === 'number') {
          inputHtml = `<input type="number" name="${key}" class="textbox" value="${currentValue || ''}" min="1" />`;
        } else if (fieldConfig.type === 'boolean') {
          inputHtml = `<input type="checkbox" name="${key}" ${currentValue ? 'checked' : ''} />`;
        } else if (fieldConfig.type === 'string') {
          if (key === 'prompt' || key === 'message') {
            inputHtml = `<textarea name="${key}" class="textbox" rows="4" style="width: 100%;" placeholder="${fieldConfig.description || ''}">${currentValue || ''}</textarea>`;
          } else {
            inputHtml = `<input type="text" name="${key}" class="textbox" value="${currentValue || ''}" placeholder="${fieldConfig.description || ''}" />`;
          }
        } else {
          inputHtml = `<input type="text" name="${key}" class="textbox" value="${currentValue || ''}" placeholder="${fieldConfig.description || ''}" />`;
        }

        // 对于 time 字段，添加提示说明它是可选的
        const isTimeField = key === 'time' && originalNode?.nodeType === 'timer';
        const timeHint = isTimeField ? '<div style="font-size: 12px; color: #666; margin-top: 4px;">提示：对于"每分钟"循环，此字段可选。不填写则从当前时间开始每N分钟执行；填写 :30 则在每分钟的第30秒执行。</div>' : '';
        
        $container.append(`
          <div style="margin-bottom: 15px;">
            <label>
              ${fieldConfig.description || key}${isTimeField ? ' (可选)' : ''}:
              ${inputHtml}
              ${timeHint}
            </label>
          </div>
        `);
      }
    }
  };

  // 编辑节点
  const handleEditNode = useCallback(async (node: Node) => {
    const originalNode = node.data.originalNode as WorkflowNode;
    if (!originalNode) {
      Notification.error('节点数据不存在');
      return;
    }

    const allNodeTypes = [...(nodeTypesData.trigger || []), ...(nodeTypesData.action || [])];
    const nodeType = allNodeTypes.find(nt => nt.nodeType === originalNode.nodeType);
    if (!nodeType) {
      Notification.error('找不到节点类型信息');
      return;
    }

    const category = originalNode.type || (nodeTypesData.trigger.some(nt => nt.nodeType === originalNode.nodeType) ? 'trigger' : 'action');

    try {
      const result = await new Promise<{ name: string; config: Record<string, any> } | null>((resolve) => {
        const $body = $(
          `<div>
            <div style="margin-bottom: 15px;">
              <label>
                节点名称:
                <input type="text" name="name" class="textbox" value="${originalNode.name}" style="width: 100%;" required />
              </label>
            </div>
            <div id="node-config-form"></div>
          </div>`
        );

        const dialog = new ActionDialog({
          $body,
          width: '600px',
        } as any);

        renderConfigForm($body.find('#node-config-form'), nodeType, category, originalNode.config, originalNode);

        dialog.open().then((action) => {
          if (action === 'ok') {
            const name = $body.find('input[name="name"]').val() as string;
            const config: Record<string, any> = {};
            // 先收集所有字段的值
            const fieldValues: Record<string, any> = {};
            $body.find('#node-config-form').find('input, select, textarea').each(function() {
              const $input = $(this);
              const inputName = $input.attr('name');
              if (inputName) {
                let value: any = $input.val();
                if ($input.attr('type') === 'checkbox') {
                  value = $input.is(':checked');
                } else if ($input.attr('type') === 'number') {
                  value = parseFloat(value as string) || 0;
                }
                fieldValues[inputName] = value;
              }
            });
            
            // 处理特殊逻辑：对于 timer 节点的 time 字段
            for (const [inputName, value] of Object.entries(fieldValues)) {
              if (inputName === 'time' && originalNode.nodeType === 'timer') {
                const interval = fieldValues.interval || 'day';
                const intervalValue = fieldValues.intervalValue || 1;
                // 如果 interval 是 minute 且 intervalValue 是 1，且 time 为空或 :0/:00，则不设置 time
                if (interval === 'minute' && intervalValue === 1 && (!value || value === '' || value === ':0' || value === ':00')) {
                  // 不设置 time，让后端从当前时间开始每60秒执行
                  continue;
                }
              }
              if (value !== '' && value !== null && value !== undefined) {
                config[inputName] = value;
              }
            }
            resolve({ name, config });
          } else {
            resolve(null);
          }
        });
      });

      if (result) {
        const updatedNode = {
          ...originalNode,
          name: result.name,
          config: result.config,
        };

        await request.post(`/workflow/${workflowId}/node/${originalNode.nid}`, {
          operation: 'update',
          name: result.name,
          config: result.config,
        });

        setNodes((nds) =>
          nds.map((n) => {
            const nodeId = parseInt(n.id.replace('node-', ''));
            return n.id === node.id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    label: result.name,
                    originalNode: updatedNode,
                    onTrigger: handleTrigger, // 确保 onTrigger 函数存在
                    onDelete: handleDeleteNode, // 确保 onDelete 函数存在
                    onStopTimer: stopTimerCountdown, // 确保 onStopTimer 函数存在
                    timerCountdown: timerCountdowns[nodeId]?.countdown, // 确保倒计时存在
                    formatTime: formatTime, // 确保 formatTime 函数存在
                  },
                }
              : n;
          })
        );

        Notification.success('节点已更新');
      }
    } catch (error: any) {
      Notification.error('更新节点失败: ' + (error.message || '未知错误'));
    }
  }, [workflowId, nodeTypesData, setNodes, handleTrigger, handleDeleteNode, stopTimerCountdown, timerCountdowns, formatTime]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const target = event.target as HTMLElement;
    // 如果点击目标是按钮或按钮内部，不触发节点编辑
    if (target.tagName === 'BUTTON' || target.closest('button')) {
      return;
    }
    handleEditNode(node);
  }, [handleEditNode]);

  const onConnect = useCallback(
    async (params: Connection) => {
      const sourceNodeId = parseInt(params.source?.replace('node-', '') || '0');
      const targetNodeId = parseInt(params.target?.replace('node-', '') || '0');

      if (!sourceNodeId || !targetNodeId) {
        Notification.error('无效的连接');
        return;
      }

      const existingEdge = edges.find(
        e => e.source === params.source && e.target === params.target
      );
      if (existingEdge) {
        Notification.info('连接已存在');
        return;
      }

      const sourceFlowNode = nodes.find(n => n.id === params.source);
      if (!sourceFlowNode) {
        Notification.error('源节点不存在');
        return;
      }

      const sourceNode = sourceFlowNode.data.originalNode as WorkflowNode;
      if (!sourceNode) {
        Notification.error('源节点数据不存在');
        return;
      }

      const targetFlowNode = nodes.find(n => n.id === params.target);
      if (!targetFlowNode) {
        Notification.error('目标节点不存在');
        return;
      }

      const alreadyConnected = sourceNode.connections?.some(
        c => c.targetNodeId === targetNodeId
      );
      if (alreadyConnected) {
        Notification.info('该连接已存在');
        return;
      }

      const updatedConnections = [
        ...(sourceNode.connections || []),
        { targetNodeId },
      ];

      const newEdge: Edge = {
        ...params,
        id: `edge-${sourceNodeId}-${targetNodeId}`,
        type: 'smoothstep',
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      };

      setEdges((eds) => addEdge(newEdge, eds));

      setNodes((nds) =>
        nds.map((n) => {
          const nodeId = parseInt(n.id.replace('node-', ''));
          if (n.id === params.source) {
            const originalNode = n.data.originalNode as WorkflowNode;
            return {
              ...n,
              data: {
                ...n.data,
                originalNode: {
                  ...originalNode,
                  connections: updatedConnections,
                },
                onTrigger: n.data.onTrigger || handleTrigger, // 确保保留 onTrigger
                onDelete: n.data.onDelete || handleDeleteNode, // 确保保留 onDelete
                onStopTimer: n.data.onStopTimer || stopTimerCountdown, // 确保保留 onStopTimer
                timerCountdown: timerCountdowns[nodeId]?.countdown, // 确保倒计时存在
                formatTime: n.data.formatTime || formatTime, // 确保保留 formatTime
              },
            };
          }
          return n;
        })
      );

      try {
        await request.post(`/workflow/${workflowId}/node/${sourceNodeId}`, {
          operation: 'update',
          connections: updatedConnections,
        });
        Notification.success('连接已保存');
      } catch (err: any) {
        console.warn('保存连接失败，将在保存工作流时同步:', err);
        Notification.info('连接已创建，将在保存工作流时同步');
      }
    },
    [workflowId, setEdges, setNodes, edges, nodes, handleTrigger, handleDeleteNode, stopTimerCountdown, timerCountdowns, formatTime]
  );

  const onNodesDragStop = useCallback(
    async (event: React.MouseEvent, node: Node) => {
      const nodeId = parseInt(node.id.replace('node-', ''));
      if (nodeId) {
        try {
          await request.post(`/workflow/${workflowId}/node/${nodeId}`, {
            operation: 'update',
            position: node.position,
          });
        } catch (error: any) {
          Notification.error('保存节点位置失败: ' + error.message);
        }
      }
    },
    [workflowId]
  );

  const handleSave = useCallback(async () => {
    try {
      for (const node of nodes) {
        const originalNode = node.data.originalNode as WorkflowNode;
        if (originalNode) {
          await request.post(`/workflow/${workflowId}/node/${originalNode.nid}`, {
            operation: 'update',
            position: node.position,
            config: originalNode.config,
            connections: originalNode.connections,
          });
        }
      }
      Notification.success('工作流已保存');
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
    }
  }, [nodes, workflowId]);

  const handleTest = useCallback(async () => {
    if (!confirm('确定要测试执行这个工作流吗？')) return;

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
    }
  }, [workflowId]);

  useEffect(() => {
    globalEditorRef = {
      handleSave,
      handleTest,
    };
    return () => {
      globalEditorRef = null;
    };
  }, [handleSave, handleTest]);

  return (
    <div style={{ display: 'flex', width: '100%', height: '600px' }}>
      <NodePalette 
        nodeTypes={nodeTypesData} 
        onDragStart={(nodeType, category) => {
          // 可以在这里添加拖拽开始时的视觉反馈
        }}
      />
      
      <div ref={reactFlowWrapper} style={{ flex: 1, height: '100%' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodesDragStop}
          onInit={setReactFlowInstance}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={customNodeTypes}
          fitView
          nodesConnectable={true}
          edgesUpdatable={true}
          edgesFocusable={true}
          connectionLineStyle={{ stroke: '#2196f3', strokeWidth: 2 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

const page = new NamedPage('workflow_editFlow', async () => {
  try {
    const $editor = $('#workflow-editor');
    if (!$editor.length) {
      return;
    }

    const workflowIdStr = $editor.data('workflow-id');
    if (!workflowIdStr) {
      console.warn('Workflow ID not found in data attribute');
      return;
    }

    const workflowId = parseInt(String(workflowIdStr), 10);
    if (isNaN(workflowId) || workflowId < 1) {
      console.error('Invalid workflow ID:', workflowIdStr);
      Notification.error('无效的工作流ID');
      return;
    }

    let nodes: WorkflowNode[] = [];
    try {
      const nodesDataStr = $editor.attr('data-workflow-nodes');
      
      if (nodesDataStr) {
        try {
          nodes = JSON.parse(nodesDataStr);
          
          if (!Array.isArray(nodes)) {
            console.error('Nodes data is not an array:', nodes);
            nodes = [];
          } else {
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
          }
        } catch (parseError: any) {
          console.error('JSON parse error:', parseError);
          
          try {
            let fixedStr = nodesDataStr
              .replace(/&quot;/g, '"')
              .replace(/&#x27;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');
            nodes = JSON.parse(fixedStr);
          } catch (fixError) {
            console.error('Failed to parse even after fixing HTML entities:', fixError);
            Notification.info('解析节点数据失败，将使用空节点列表');
            nodes = [];
          }
        }
      }
    } catch (error: any) {
      console.error('Failed to parse workflow nodes:', error);
      Notification.info('解析节点数据失败，将使用空节点列表');
      nodes = [];
    }

    ReactDOM.render(
      <WorkflowEditor workflowId={workflowId} initialNodes={nodes} />,
      $editor[0]
    );

    $('#save-workflow-btn').on('click', () => {
      if (globalEditorRef && globalEditorRef.handleSave) {
        globalEditorRef.handleSave();
      }
    });

    $('#test-workflow-btn').on('click', () => {
      if (globalEditorRef && globalEditorRef.handleTest) {
        globalEditorRef.handleTest();
      }
    });
  } catch (error: any) {
    console.error('Failed to initialize workflow editor:', error);
    Notification.error('初始化工作流编辑器失败: ' + (error.message || '未知错误'));
  }
});

export default page;


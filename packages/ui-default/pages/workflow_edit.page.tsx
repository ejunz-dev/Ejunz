import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
      <div style={{ fontSize: '12px', color: '#666' }}>
        {data.nodeType}
      </div>
      
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

let globalEditorRef: any = null;

function WorkflowEditor({ workflowId, initialNodes }: { workflowId: number; initialNodes: WorkflowNode[] }) {
  const [nodeTypes, setNodeTypes] = useState<NodeType[]>([]);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);

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
      },
    })) as Node[];
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

  const [nodes, setNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlowEdges);

  useEffect(() => {
    loadNodeTypes();
  }, []);

  const loadNodeTypes = async () => {
    try {
      const response = await request.get('/workflow/node-types');
      setNodeTypes(response.nodeTypes || []);
    } catch (error: any) {
      Notification.error('加载节点类型失败: ' + (error.message || '未知错误'));
    }
  };

  const handleAddNode = useCallback(async () => {
    try {
      // 获取节点类型（分为 trigger 和 action 两大类）
      const nodeTypesResponse = await request.get('/workflow/node-types');
      const nodeTypesData = nodeTypesResponse.nodeTypes || { trigger: [], action: [] };

      // 第一步：选择大类（触发器/执行）
      const category = await new Promise<'trigger' | 'action'>((resolve, reject) => {
        const $body = $(
          `<div>
            <label>选择节点类型:</label>
            <select class="textbox" id="node-category-select" style="width: 100%; margin-top: 10px;">
              <option value="trigger">触发器</option>
              <option value="action">执行</option>
            </select>
          </div>`
        );

        const dialog = new ActionDialog({
          $body,
          width: '400px',
        } as any);

        dialog.open().then((action) => {
          if (action === 'ok') {
            const category = $body.find('#node-category-select').val() as 'trigger' | 'action';
            resolve(category);
          } else {
            reject(new Error('取消'));
          }
        });
      });

      // 第二步：选择具体子类型并配置
      const subTypes = nodeTypesData[category] || [];
      const subTypeOptions = subTypes.map((t: any) => ({
        label: `${t.name} - ${t.description}`,
        value: t.nodeType,
        data: t,
      }));

      const selected = await new Promise<{ value: string; data: any; category: string }>((resolve, reject) => {
        const $body = $(
          `<div>
            <label>选择${category === 'trigger' ? '触发器' : '执行'}类型:</label>
            <select class="textbox" id="node-subtype-select" style="width: 100%; margin-top: 10px;">
              ${subTypeOptions.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join('')}
            </select>
            <div id="node-config-form" style="margin-top: 20px;"></div>
          </div>`
        );

        const dialog = new ActionDialog({
          $body,
          width: '600px',
        } as any);

        const $select = $body.find('#node-subtype-select');
        const $configForm = $body.find('#node-config-form');

        const updateConfigForm = async () => {
          const selectedType = subTypes.find((t: any) => t.nodeType === $select.val());
          if (selectedType) {
            await renderConfigForm($configForm, selectedType, category);
          }
        };

        $select.on('change', updateConfigForm);
        updateConfigForm();

        dialog.open().then((action) => {
          if (action === 'ok') {
            const selectedType = subTypes.find((t: any) => t.nodeType === $select.val());
            if (selectedType) {
              const config: Record<string, any> = {};
              $configForm.find('input, select, textarea').each(function() {
                const $input = $(this);
                const name = $input.attr('name');
                if (name) {
                  let value: any = $input.val();
                  if ($input.attr('type') === 'checkbox') {
                    value = $input.is(':checked');
                  } else if ($input.attr('type') === 'number') {
                    value = parseFloat(value as string) || 0;
                  }
                  if (value !== '' && value !== null && value !== undefined) {
                    config[name] = value;
                  }
                }
              });
              resolve({ value: $select.val() as string, data: { ...selectedType, config }, category });
            } else {
              reject(new Error('未选择节点类型'));
            }
          } else {
            reject(new Error('取消'));
          }
        });
      });

      // 计算新节点的位置（放在画布中心偏右）
      const newNodePosition = {
        x: Math.max(...nodes.map(n => n.position.x), 300) + 200,
        y: 200,
      };

      const newNode: Partial<WorkflowNode> = {
        name: `新节点 ${nodes.length + 1}`,
        nodeType: selected.value,
        type: selected.category, // trigger 或 action
        position: newNodePosition,
        config: selected.data.config || {},
        connections: [],
      };

      const response = await request.post(`/workflow/${workflowId}/node`, {
        operation: 'create',
        ...newNode,
      });
      const createdNode = response.node;

      // 添加到 ReactFlow
      const newFlowNode: Node = {
        id: `node-${createdNode.nid}`,
        type: 'custom',
        position: newNodePosition,
        data: {
          label: createdNode.name,
          nodeType: createdNode.nodeType,
          originalNode: createdNode,
        },
      };

      setNodes((nds) => [...nds, newFlowNode]);
      Notification.success('节点添加成功');
    } catch (error: any) {
      if (error.message !== '取消') {
        Notification.error('添加节点失败: ' + (error.message || '未知错误'));
      }
    }
  }, [workflowId, nodeTypes, nodes, setNodes]);

  const renderConfigForm = async ($container: JQuery, nodeType: any, category: string) => {
    $container.empty();
    const schema = nodeType.configSchema || {};

    // 特殊处理：对象操作需要先选择节点，然后加载设备列表
    if (nodeType.nodeType === 'object_action') {
      // 加载节点列表
      const nodesResponse = await request.get('/workflow/nodes');
      const nodesList = nodesResponse.nodes || [];
      
      $container.append(`
        <div style="margin-bottom: 15px;">
          <label>
            选择节点:
            <select name="nodeId" class="textbox" id="object-node-select" style="width: 100%;" required>
              <option value="">请选择节点</option>
              ${nodesList.map((n: any) => `<option value="${n.nid}">${n.name}</option>`).join('')}
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

      // 当节点改变时，加载设备列表
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
              devicesList.map((d: any) => `<option value="${d.deviceId}">${d.name} (${d.type})</option>`).join('')
            );
          } catch (error: any) {
            $deviceSelect.html('<option value="">加载失败</option>');
            Notification.error('加载设备列表失败: ' + error.message);
          }
        } else {
          $deviceSelect.html('<option value="">请先选择节点</option>');
        }
      });

      // 操作类型
      $container.append(`
        <div style="margin-bottom: 15px;">
          <label>
            操作类型:
            <select name="action" class="textbox" style="width: 100%;" required>
              <option value="on">开启</option>
              <option value="off">关闭</option>
              <option value="toggle">切换</option>
              <option value="set">设置</option>
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            属性名（可选，如 on, brightness）:
            <input type="text" name="property" class="textbox" placeholder="属性名" />
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            设置值（当操作类型为"设置"时）:
            <input type="text" name="value" class="textbox" placeholder="设置值" />
          </label>
        </div>
      `);
    } else if (nodeType.nodeType === 'agent_action') {
      // Agent操作：需要选择Agent和配置提示词
      const agentsResponse = await request.get('/workflow/agents');
      const agentsList = agentsResponse.agents || [];
      
      $container.append(`
        <div style="margin-bottom: 15px;">
          <label>
            选择Agent:
            <select name="agentId" class="textbox" style="width: 100%;" required>
              <option value="">请选择Agent</option>
              ${agentsList.map((a: any) => `<option value="${a.aid}">${a.name}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            操作类型:
            <select name="action" class="textbox" style="width: 100%;" required>
              <option value="message">发送私信</option>
              <option value="generate">生成内容</option>
            </select>
          </label>
        </div>
        <div style="margin-bottom: 15px;">
          <label>
            提示词（支持 \${variable} 变量）:
            <textarea name="prompt" class="textbox" rows="4" style="width: 100%;" placeholder="输入提示词..." required></textarea>
          </label>
        </div>
        <div style="margin-bottom: 15px;" id="agent-user-select-container">
          <label>
            目标用户ID（当操作类型为"发送私信"时）:
            <input type="number" name="userId" class="textbox" placeholder="用户ID" />
          </label>
        </div>
      `);

      // 当操作类型改变时，显示/隐藏用户ID输入
      $container.find('select[name="action"]').on('change', function() {
        const action = $(this).val();
        const $userContainer = $container.find('#agent-user-select-container');
        if (action === 'message') {
          $userContainer.show();
        } else {
          $userContainer.hide();
        }
      });
    } else {
      // 其他类型：使用通用配置表单
      for (const [key, field] of Object.entries(schema)) {
        const fieldConfig = field as any;
        let inputHtml = '';

        if (fieldConfig.enum) {
          inputHtml = `
            <select name="${key}" class="textbox" style="width: 100%;">
              ${fieldConfig.enum.map((opt: any) => `<option value="${opt}" ${fieldConfig.default === opt ? 'selected' : ''}>${opt}</option>`).join('')}
            </select>
          `;
        } else if (fieldConfig.type === 'number') {
          inputHtml = `<input type="number" name="${key}" class="textbox" value="${fieldConfig.default || ''}" min="1" />`;
        } else if (fieldConfig.type === 'boolean') {
          inputHtml = `<input type="checkbox" name="${key}" ${fieldConfig.default ? 'checked' : ''} />`;
        } else if (fieldConfig.type === 'string') {
          if (key === 'prompt' || key === 'message') {
            inputHtml = `<textarea name="${key}" class="textbox" rows="4" style="width: 100%;" placeholder="${fieldConfig.description || ''}">${fieldConfig.default || ''}</textarea>`;
          } else {
            inputHtml = `<input type="text" name="${key}" class="textbox" value="${fieldConfig.default || ''}" placeholder="${fieldConfig.description || ''}" />`;
          }
        } else {
          inputHtml = `<input type="text" name="${key}" class="textbox" value="${fieldConfig.default || ''}" placeholder="${fieldConfig.description || ''}" />`;
        }

        $container.append(`
          <div style="margin-bottom: 15px;">
            <label>
              ${fieldConfig.description || key}:
              ${inputHtml}
            </label>
          </div>
        `);
      }
    }
  };

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const originalNode = node.data.originalNode as WorkflowNode;
    setSelectedNode(originalNode);
  }, []);

  const onConnect = useCallback(
    async (params: Connection) => {
      const sourceNodeId = parseInt(params.source?.replace('node-', '') || '0');
      const targetNodeId = parseInt(params.target?.replace('node-', '') || '0');

      if (!sourceNodeId || !targetNodeId) {
        Notification.error('无效的连接');
        return;
      }

      // 检查是否已经存在连接
      const existingEdge = edges.find(
        e => e.source === params.source && e.target === params.target
      );
      if (existingEdge) {
        Notification.info('连接已存在');
        return;
      }

      // 更新原始节点的 connections
      const sourceNode = initialNodes.find(n => n.nid === sourceNodeId);
      if (!sourceNode) {
        Notification.error('源节点不存在');
        return;
      }

      // 检查是否已经连接到目标节点
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

      // 先立即添加边到 ReactFlow，让连接立即显示
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

      // 更新本地节点数据
      setNodes((nds) =>
        nds.map((n) => {
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
              },
            };
          }
          return n;
        })
      );

      // 然后异步保存到后端
      try {
        await request.post(`/workflow/${workflowId}/node/${sourceNodeId}`, {
          operation: 'update',
          connections: updatedConnections,
        });
        Notification.success('连接已保存');
      } catch (err: any) {
        // 如果保存失败，回滚连接
        setEdges((eds) => eds.filter(e => e.id !== newEdge.id));
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === params.source) {
              const originalNode = n.data.originalNode as WorkflowNode;
              return {
                ...n,
                data: {
                  ...n.data,
                  originalNode: {
                    ...originalNode,
                    connections: sourceNode.connections || [],
                  },
                },
              };
            }
            return n;
          })
        );
        Notification.error('保存连接失败: ' + (err.message || '未知错误'));
      }
    },
    [workflowId, initialNodes, setEdges, setNodes, edges]
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
      // 保存所有节点的位置和配置
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
      handleAddNode,
      handleSave,
      handleTest,
    };
    return () => {
      globalEditorRef = null;
    };
  }, [handleAddNode, handleSave, handleTest]);

  return (
    <div style={{ width: '100%', height: '600px', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodesDragStop}
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

      {selectedNode && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            width: '300px',
            padding: '15px',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            zIndex: 1000,
            maxHeight: '80vh',
            overflowY: 'auto',
          }}
        >
          <h3 style={{ marginTop: 0 }}>节点配置</h3>
          <div style={{ marginBottom: '10px' }}>
            <label>名称:</label>
            <input
              type="text"
              value={selectedNode.name}
              onChange={(e) => {
                const updated = { ...selectedNode, name: e.target.value };
                setSelectedNode(updated);
                // 更新 ReactFlow 节点
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === `node-${selectedNode.nid}`
                      ? { ...n, data: { ...n.data, label: e.target.value, originalNode: updated } }
                      : n
                  )
                );
              }}
              className="textbox"
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginBottom: '10px' }}>
            <label>配置:</label>
            <textarea
              value={JSON.stringify(selectedNode.config, null, 2)}
              onChange={(e) => {
                try {
                  const config = JSON.parse(e.target.value);
                  const updated = { ...selectedNode, config };
                  setSelectedNode(updated);
                  // 更新 ReactFlow 节点
                  setNodes((nds) =>
                    nds.map((n) =>
                      n.id === `node-${selectedNode.nid}`
                        ? { ...n, data: { ...n.data, originalNode: updated } }
                        : n
                    )
                  );
                } catch (err) {
                  // 忽略 JSON 解析错误
                }
              }}
              className="textbox"
              style={{ width: '100%', height: '200px', fontFamily: 'monospace', fontSize: '12px' }}
            />
          </div>
          <button
            onClick={() => setSelectedNode(null)}
            className="button"
            style={{ width: '100%', marginTop: '10px' }}
          >
            关闭
          </button>
        </div>
      )}
    </div>
  );
}

const page = new NamedPage('workflow_edit', async () => {
  try {
    const $editor = $('#workflow-editor');
    if (!$editor.length) {
      // 如果没有编辑器容器，可能是创建新工作流页面，不需要初始化编辑器
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
      // 检查节点数量
      const nodesCount = $editor.attr('data-nodes-count');
      console.log('Nodes count from data attribute:', nodesCount);
      
      // 使用 attr() 获取原始字符串，避免 jQuery 的自动解析
      const nodesDataStr = $editor.attr('data-workflow-nodes');
      console.log('Raw nodes data string from DOM:', nodesDataStr);
      console.log('Raw nodes data string length:', nodesDataStr?.length);
      console.log('Raw nodes data string type:', typeof nodesDataStr);
      
      // 检查 HTML 元素的实际属性值
      const rawAttr = $editor[0]?.getAttribute('data-workflow-nodes');
      console.log('Raw attribute value from element:', rawAttr);
      console.log('Raw attribute value length:', rawAttr?.length);
      
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
          console.error('Parse error message:', parseError.message);
          console.error('Failed to parse string (first 200 chars):', nodesDataStr?.substring(0, 200));
          console.error('Failed to parse string (last 200 chars):', nodesDataStr?.substring(Math.max(0, (nodesDataStr?.length || 0) - 200)));
          
          // 尝试修复常见的 JSON 问题
          try {
            // 尝试处理 HTML 转义
            let fixedStr = nodesDataStr
              .replace(/&quot;/g, '"')
              .replace(/&#x27;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');
            nodes = JSON.parse(fixedStr);
            console.log('Successfully parsed after fixing HTML entities');
          } catch (fixError) {
            console.error('Failed to parse even after fixing HTML entities:', fixError);
            Notification.info('解析节点数据失败，将使用空节点列表');
            nodes = [];
          }
        }
      } else {
        console.warn('No nodes data found in data-workflow-nodes attribute');
      }
    } catch (error: any) {
      console.error('Failed to parse workflow nodes:', error);
      console.error('Error stack:', error.stack);
      Notification.info('解析节点数据失败，将使用空节点列表');
      nodes = [];
    }

    ReactDOM.render(
      <WorkflowEditor workflowId={workflowId} initialNodes={nodes} />,
      $editor[0]
    );

    $('#add-node-btn').on('click', () => {
      if (globalEditorRef && globalEditorRef.handleAddNode) {
        globalEditorRef.handleAddNode();
      }
    });

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

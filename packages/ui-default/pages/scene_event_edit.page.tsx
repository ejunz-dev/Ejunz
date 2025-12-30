import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
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

interface TargetAction {
  targetNodeId?: number; // Node设备控制
  targetDeviceId?: string; // Node设备控制
  targetClientId?: number; // Client组件控制
  targetWidgetName?: string; // Client组件控制
  targetAction: string;
  targetValue?: any;
  order?: number;
}

interface SceneEventData {
  name: string;
  description?: string;
  sourceNodeId?: number; // Node设备监听
  sourceDeviceId?: string; // Node设备监听
  sourceClientId?: number; // Client组件监听 或 GSI数据监听
  sourceWidgetName?: string; // Client组件监听
  sourceGsiPath?: string; // GSI数据路径
  sourceGsiOperator?: string; // GSI比较操作符
  sourceGsiValue?: any; // GSI比较值
  sourceAction?: string;
  targets?: TargetAction[];
  targetNodeId?: number; // 向后兼容
  targetDeviceId?: string; // 向后兼容
  targetAction?: string; // 向后兼容
  targetValue?: any; // 向后兼容
  enabled: boolean;
  triggerLimit?: number; // 触发次数限制（0表示不限制，-1表示只触发一次）
  triggerDelay?: number; // 延时触发时间（毫秒）
}

declare global {
  interface Window {
    nodeDevicesMap?: Record<number, Array<{ deviceId: string; name: string }>>;
    nodes?: Array<{ nid: number; name: string }>;
    clients?: Array<{ clientId: number; name: string }>;
    clientWidgetsMap?: Record<number, Array<string>>; // clientId -> widget names
    clientGsiFieldsMap?: Record<number, Array<{ path: string; type: string; values?: string[]; range?: [number, number]; nullable?: boolean }>>; // clientId -> GSI fields
    domainId?: string;
    sceneId?: number;
  }
}

// 自定义触发效果节点
const TargetActionNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [config, setConfig] = useState(data.config || {});

  // 当data.config更新时，同步更新本地state（如果不在编辑状态）
  useEffect(() => {
    if (!isEditing && data.config) {
      setConfig(data.config);
    }
  }, [data.config, isEditing]);

  const handleEdit = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleSave = useCallback(() => {
    if (data.onUpdate) {
      data.onUpdate(config);
    }
    setIsEditing(false);
  }, [data, config]);

  const handleDelete = useCallback(() => {
    if (data.onDelete) {
      data.onDelete();
    }
  }, [data]);

  return (
    <div
      style={{
        background: selected ? '#e3f2fd' : '#fff',
        border: `2px solid ${selected ? '#2196f3' : '#ddd'}`,
        borderRadius: '8px',
        padding: '15px',
        minWidth: '200px',
        boxShadow: selected ? '0 4px 12px rgba(33, 150, 243, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
        transition: 'all 0.2s',
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

      {/* 删除按钮 */}
      <button
        onClick={handleDelete}
        onMouseDown={(e) => e.stopPropagation()}
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
        }}
        title="删除触发效果"
      >
        ×
      </button>

      {!isEditing ? (
        <>
          <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '14px' }}>
            触发效果
          </div>
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
            {config.targetClientId ? (
              <>
                <div>类型: Client组件</div>
                <div>Client: {config.targetClientName || config.targetClientId}</div>
                <div>组件: {config.targetWidgetName || '-'}</div>
                <div>动作: {config.targetAction === 'on' ? '显示' : config.targetAction === 'off' ? '隐藏' : '切换'}</div>
              </>
            ) : (
              <>
                <div>类型: Node设备</div>
            <div>节点: {config.targetNodeName || config.targetNodeId}</div>
            <div>设备: {config.targetDeviceName || config.targetDeviceId}</div>
            <div>动作: {config.targetAction === 'on' ? '开启' : config.targetAction === 'off' ? '关闭' : '切换'}</div>
            {config.targetValue && <div>值: {String(config.targetValue)}</div>}
              </>
            )}
          </div>
          <button
            onClick={handleEdit}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              padding: '6px 12px',
              marginTop: '8px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              backgroundColor: '#2196f3',
              color: '#fff',
            }}
          >
            编辑
          </button>
        </>
      ) : (
        <div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>目标类型</label>
            <select
              value={config.targetType || (config.targetClientId ? 'client' : 'node')}
              onChange={(e) => {
                const newType = e.target.value;
                if (newType === 'client') {
                  setConfig({ ...config, targetType: 'client', targetNodeId: undefined, targetDeviceId: undefined });
                } else {
                  setConfig({ ...config, targetType: 'node', targetClientId: undefined, targetWidgetName: undefined });
                }
              }}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="node">Node设备</option>
              <option value="client">Client组件</option>
            </select>
          </div>
          
          {(!config.targetType || config.targetType === 'node') ? (
            <>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>节点</label>
            <select
              value={config.targetNodeId || ''}
              onChange={(e) => setConfig({ ...config, targetNodeId: parseInt(e.target.value, 10) })}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="">请选择</option>
              {(window.nodeDevicesMap ? Object.keys(window.nodeDevicesMap).map(nid => {
                const node = window.nodes?.find((n: any) => n.nid === parseInt(nid, 10));
                return <option key={nid} value={nid}>{node?.name || `Node ${nid}`}</option>;
              }) : [])}
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>设备</label>
            <select
              value={config.targetDeviceId || ''}
              onChange={(e) => setConfig({ ...config, targetDeviceId: e.target.value })}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="">请先选择节点</option>
              {config.targetNodeId && window.nodeDevicesMap?.[config.targetNodeId]?.map((device: any) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.name} ({device.deviceId})
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>动作</label>
            <select
              value={config.targetAction || ''}
              onChange={(e) => setConfig({ ...config, targetAction: e.target.value })}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="on">开启</option>
              <option value="off">关闭</option>
              <option value="toggle">切换</option>
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>值（可选）</label>
            <input
              type="text"
              value={config.targetValue || ''}
              onChange={(e) => setConfig({ ...config, targetValue: e.target.value })}
              placeholder="例如: true, 100"
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            />
          </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>Client</label>
                <select
                  value={config.targetClientId || ''}
                  onChange={(e) => {
                    const clientId = e.target.value ? parseInt(e.target.value, 10) : undefined;
                    setConfig({ ...config, targetClientId: clientId, targetWidgetName: undefined });
                  }}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="">请选择</option>
                  {(window.clients || []).map((client: any) => (
                    <option key={client.clientId} value={client.clientId}>
                      {client.name} (ID: {client.clientId})
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>组件</label>
                <select
                  value={config.targetWidgetName || ''}
                  onChange={(e) => setConfig({ ...config, targetWidgetName: e.target.value })}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="">请先选择Client</option>
                  {config.targetClientId && window.clientWidgetsMap?.[config.targetClientId]?.map((widget: string) => (
                    <option key={widget} value={widget}>
                      {widget}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>动作</label>
                <select
                  value={config.targetAction || ''}
                  onChange={(e) => setConfig({ ...config, targetAction: e.target.value })}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="on">显示</option>
                  <option value="off">隐藏</option>
                  <option value="toggle">切换</option>
                </select>
              </div>
            </>
          )}
          <button
            onClick={handleSave}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              padding: '6px 12px',
              marginTop: '8px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              backgroundColor: '#4caf50',
              color: '#fff',
            }}
          >
            保存
          </button>
        </div>
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

// 自定义监听源节点
const SourceNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [config, setConfig] = useState(data.config || {});

  const handleEdit = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleSave = useCallback(() => {
    if (data.onUpdate) {
      data.onUpdate(config);
    }
    setIsEditing(false);
  }, [data, config]);

  return (
    <div
      style={{
        background: selected ? '#fff3e0' : '#fff',
        border: `2px solid ${selected ? '#ff9800' : '#ddd'}`,
        borderRadius: '8px',
        padding: '15px',
        minWidth: '200px',
        boxShadow: selected ? '0 4px 12px rgba(255, 152, 0, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '14px', color: '#ff9800' }}>
        监听源
      </div>
      {!isEditing ? (
        <>
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
            {config.sourceClientId !== undefined && config.sourceClientId !== null ? (
              <>
                <div>类型: Client</div>
                <div>Client: {config.sourceClientName || `Client-${config.sourceClientId}`}</div>
                {config.sourceGsiPath ? (
                  <>
                    <div>Client类型: GSI数据</div>
                    <div>路径: {config.sourceGsiPath || '-'}</div>
                    <div>操作符: {config.sourceGsiOperator || 'eq'}</div>
                    <div>值: {JSON.stringify(config.sourceGsiValue) || '-'}</div>
                  </>
                ) : (
                  <>
                    <div>Client类型: 组件状态</div>
                    <div>组件: {config.sourceWidgetName || '-'}</div>
                    <div>动作: {config.sourceAction || '任意变化'}</div>
                  </>
                )}
              </>
            ) : (
              <>
                <div>类型: Node设备</div>
                <div>节点: {config.sourceNodeName || (config.sourceNodeId !== undefined ? `Node ${config.sourceNodeId}` : '-')}</div>
                <div>设备: {config.sourceDeviceName || (config.sourceDeviceId || '-')}</div>
                <div>动作: {config.sourceAction || '任意变化'}</div>
              </>
            )}
          </div>
          <button
            onClick={handleEdit}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              padding: '6px 12px',
              marginTop: '8px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              backgroundColor: '#ff9800',
              color: '#fff',
            }}
          >
            编辑
          </button>
        </>
      ) : (
        <div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>源类型</label>
            <select
              value={config.sourceType || (config.sourceClientId ? 'client' : 'node')}
              onChange={(e) => {
                const newType = e.target.value;
                if (newType === 'client') {
                  setConfig({ 
                    ...config, 
                    sourceType: 'client', 
                    sourceNodeId: undefined, 
                    sourceDeviceId: undefined,
                    sourceClientType: config.sourceClientType || 'widget' // 默认组件状态
                  });
                } else {
                  setConfig({ 
                    ...config, 
                    sourceType: 'node', 
                    sourceClientId: undefined, 
                    sourceWidgetName: undefined,
                    sourceGsiPath: undefined,
                    sourceGsiOperator: undefined,
                    sourceGsiValue: undefined,
                    sourceClientType: undefined
                  });
                }
              }}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="node">Node设备</option>
              <option value="client">Client</option>
            </select>
          </div>
          
          {config.sourceType === 'client' ? (
            <>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>Client类型</label>
                <select
                  value={config.sourceClientType || (config.sourceGsiPath ? 'gsi' : 'widget')}
                  onChange={(e) => {
                    const newClientType = e.target.value;
                    if (newClientType === 'gsi') {
                      setConfig({ 
                        ...config, 
                        sourceClientType: 'gsi',
                        sourceWidgetName: undefined,
                        sourceAction: undefined
                      });
                    } else {
                      setConfig({ 
                        ...config, 
                        sourceClientType: 'widget',
                        sourceGsiPath: undefined,
                        sourceGsiOperator: undefined,
                        sourceGsiValue: undefined
                      });
                    }
                  }}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="widget">组件状态</option>
                  <option value="gsi">GSI数据</option>
                </select>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>Client</label>
                <select
                  value={config.sourceClientId || ''}
                  onChange={(e) => {
                    const clientId = e.target.value ? parseInt(e.target.value, 10) : undefined;
                    setConfig({ ...config, sourceClientId: clientId });
                  }}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="">请选择</option>
                  {(window.clients || []).map((client: any) => (
                    <option key={client.clientId} value={client.clientId}>
                      {client.name} (ID: {client.clientId})
                    </option>
                  ))}
                </select>
              </div>
              
              {config.sourceClientType === 'gsi' ? (
                <>
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>GSI字段</label>
                    <select
                      value={config.sourceGsiPath || ''}
                      onChange={(e) => {
                        const selectedPath = e.target.value;
                        const selectedField = config.sourceClientId 
                          ? window.clientGsiFieldsMap?.[config.sourceClientId]?.find((f: any) => f.path === selectedPath)
                          : undefined;
                        setConfig({ 
                          ...config, 
                          sourceGsiPath: selectedPath || undefined,
                          sourceGsiValue: undefined, // 清空值，让用户重新选择
                        });
                      }}
                      style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                    >
                      <option value="">请选择字段</option>
                      {config.sourceClientId && window.clientGsiFieldsMap?.[config.sourceClientId]?.map((field: any) => (
                        <option key={field.path} value={field.path}>
                          {field.path} ({field.type})
                        </option>
                      ))}
                    </select>
                    {!config.sourceClientId && (
                      <div style={{ fontSize: '10px', color: '#999', marginTop: '2px' }}>
                        请先选择Client
                      </div>
                    )}
                    {config.sourceClientId && (!window.clientGsiFieldsMap?.[config.sourceClientId] || window.clientGsiFieldsMap[config.sourceClientId].length === 0) && (
                      <div style={{ fontSize: '10px', color: '#f44336', marginTop: '2px' }}>
                        该Client暂无GSI字段，请等待客户端连接并完成握手
                      </div>
                    )}
                  </div>
                  
                  {config.sourceGsiPath && (() => {
                    const selectedField = config.sourceClientId 
                      ? window.clientGsiFieldsMap?.[config.sourceClientId]?.find((f: any) => f.path === config.sourceGsiPath)
                      : undefined;
                    
                    return (
                      <>
                        <div style={{ marginBottom: '8px' }}>
                          <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>操作符</label>
                          <select
                            value={config.sourceGsiOperator || 'eq'}
                            onChange={(e) => setConfig({ ...config, sourceGsiOperator: e.target.value })}
                            style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                          >
                            <option value="eq">等于 (==)</option>
                            <option value="ne">不等于 (!=)</option>
                            <option value="gt">大于 (&gt;)</option>
                            <option value="gte">大于等于 (&gt;=)</option>
                            <option value="lt">小于 (&lt;)</option>
                            <option value="lte">小于等于 (&lt;=)</option>
                            <option value="in">包含在数组中</option>
                            <option value="contains">字符串包含</option>
                          </select>
                        </div>
                        
                        <div style={{ marginBottom: '8px' }}>
                          <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>比较值</label>
                          {selectedField?.values && selectedField.values.length > 0 ? (
                            // 如果有枚举值，显示下拉选择
                            <select
                              value={config.sourceGsiValue !== undefined && config.sourceGsiValue !== null ? String(config.sourceGsiValue) : ''}
                              onChange={(e) => {
                                const value = e.target.value;
                                let parsedValue: any = value;
                                if (value === '') {
                                  parsedValue = undefined;
                                } else if (selectedField.type === 'number' && !isNaN(Number(value))) {
                                  parsedValue = Number(value);
                                } else if (selectedField.type === 'boolean') {
                                  parsedValue = value === 'true';
                                }
                                setConfig({ ...config, sourceGsiValue: parsedValue });
                              }}
                              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                            >
                              <option value="">请选择值</option>
                              {selectedField.values.map((val: any) => (
                                <option key={val} value={String(val)}>
                                  {String(val)}
                                </option>
                              ))}
                            </select>
                          ) : selectedField?.type === 'boolean' ? (
                            // 布尔类型，显示 true/false 选择
                            <select
                              value={config.sourceGsiValue !== undefined && config.sourceGsiValue !== null ? String(config.sourceGsiValue) : ''}
                              onChange={(e) => {
                                const value = e.target.value;
                                setConfig({ ...config, sourceGsiValue: value === '' ? undefined : value === 'true' });
                              }}
                              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                            >
                              <option value="">请选择值</option>
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : (
                            // 其他类型，显示文本输入
                            <input
                              type="text"
                              value={config.sourceGsiValue !== undefined && config.sourceGsiValue !== null ? String(config.sourceGsiValue) : ''}
                              onChange={(e) => {
                                const value = e.target.value;
                                let parsedValue: any = value;
                                if (value === '') {
                                  parsedValue = undefined;
                                } else if (selectedField?.type === 'number' && !isNaN(Number(value)) && value.trim() !== '') {
                                  parsedValue = Number(value);
                                } else if (value.startsWith('[') || value.startsWith('{')) {
                                  try {
                                    parsedValue = JSON.parse(value);
                                  } catch {
                                    parsedValue = value;
                                  }
                                }
                                setConfig({ ...config, sourceGsiValue: parsedValue });
                              }}
                              placeholder={selectedField?.range ? `范围: ${selectedField.range[0]}-${selectedField.range[1]}` : "例如: 100 或 'live' 或 [1,2,3]"}
                              style={{ width: '100%', padding: '4px', fontSize: '11px', boxSizing: 'border-box' }}
                            />
                          )}
                          {selectedField?.range && (
                            <div style={{ fontSize: '10px', color: '#999', marginTop: '2px' }}>
                              范围: {selectedField.range[0]} - {selectedField.range[1]}
                            </div>
                          )}
                          {selectedField?.values && selectedField.values.length > 0 && (
                            <div style={{ fontSize: '10px', color: '#999', marginTop: '2px' }}>
                              可监听的值: {selectedField.values.join(', ')}
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </>
              ) : (
                <>
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>组件</label>
                    <select
                      value={config.sourceWidgetName || ''}
                      onChange={(e) => setConfig({ ...config, sourceWidgetName: e.target.value })}
                      style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                    >
                      <option value="">请先选择Client</option>
                      {config.sourceClientId && window.clientWidgetsMap?.[config.sourceClientId]?.map((widget: string) => (
                        <option key={widget} value={widget}>
                          {widget}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>动作（可选）</label>
                    <select
                      value={config.sourceAction || ''}
                      onChange={(e) => setConfig({ ...config, sourceAction: e.target.value })}
                      style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                    >
                      <option value="">任意变化</option>
                      <option value="on">显示</option>
                      <option value="off">隐藏</option>
                      <option value="toggle">切换</option>
                    </select>
                  </div>
                </>
              )}
            </>
          ) : (!config.sourceType || config.sourceType === 'node') ? (
            <>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>节点</label>
            <select
              value={config.sourceNodeId || ''}
              onChange={(e) => setConfig({ ...config, sourceNodeId: parseInt(e.target.value, 10) })}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="">请选择</option>
              {(window.nodeDevicesMap ? Object.keys(window.nodeDevicesMap).map(nid => {
                const node = window.nodes?.find((n: any) => n.nid === parseInt(nid, 10));
                return <option key={nid} value={nid}>{node?.name || `Node ${nid}`}</option>;
              }) : [])}
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>设备</label>
            <select
              value={config.sourceDeviceId || ''}
              onChange={(e) => setConfig({ ...config, sourceDeviceId: e.target.value })}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="">请先选择节点</option>
              {config.sourceNodeId && window.nodeDevicesMap?.[config.sourceNodeId]?.map((device: any) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.name} ({device.deviceId})
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>动作（可选）</label>
            <select
              value={config.sourceAction || ''}
              onChange={(e) => setConfig({ ...config, sourceAction: e.target.value })}
              style={{ width: '100%', padding: '4px', fontSize: '11px' }}
            >
              <option value="">任意变化</option>
              <option value="on">开启</option>
              <option value="off">关闭</option>
              <option value="toggle">切换</option>
            </select>
          </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>Client</label>
                <select
                  value={config.sourceClientId || ''}
                  onChange={(e) => {
                    const clientId = e.target.value ? parseInt(e.target.value, 10) : undefined;
                    setConfig({ ...config, sourceClientId: clientId, sourceWidgetName: undefined });
                  }}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="">请选择</option>
                  {(window.clients || []).map((client: any) => (
                    <option key={client.clientId} value={client.clientId}>
                      {client.name} (ID: {client.clientId})
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>组件</label>
                <select
                  value={config.sourceWidgetName || ''}
                  onChange={(e) => setConfig({ ...config, sourceWidgetName: e.target.value })}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="">请先选择Client</option>
                  {config.sourceClientId && window.clientWidgetsMap?.[config.sourceClientId]?.map((widget: string) => (
                    <option key={widget} value={widget}>
                      {widget}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px' }}>动作（可选）</label>
                <select
                  value={config.sourceAction || ''}
                  onChange={(e) => setConfig({ ...config, sourceAction: e.target.value })}
                  style={{ width: '100%', padding: '4px', fontSize: '11px' }}
                >
                  <option value="">任意变化</option>
                  <option value="on">显示</option>
                  <option value="off">隐藏</option>
                  <option value="toggle">切换</option>
                </select>
              </div>
            </>
          )}
          <button
            onClick={handleSave}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              padding: '6px 12px',
              marginTop: '8px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              backgroundColor: '#4caf50',
              color: '#fff',
            }}
          >
            保存
          </button>
        </div>
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
  source: SourceNode,
  target: TargetActionNode,
};

function SceneEventEditor({ eventId, initialData }: { eventId?: number; initialData?: SceneEventData }) {
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [eventName, setEventName] = useState(initialData?.name || '');
  const [eventDescription, setEventDescription] = useState(initialData?.description || '');
  const [eventEnabled, setEventEnabled] = useState(initialData?.enabled !== false);
  const [triggerLimit, setTriggerLimit] = useState<number | ''>(initialData?.triggerLimit ?? '');
  const [triggerDelay, setTriggerDelay] = useState<number | ''>(initialData?.triggerDelay ?? '');
  const [isSaving, setIsSaving] = useState(false);

  // 初始化节点
  const initialNodes = useMemo(() => {
    const nodes: Node[] = [];
    
    // 监听源节点
    if (initialData) {
      const sourceNode: Node = {
        id: 'source',
        type: 'source',
        position: { x: 100, y: 200 },
        data: {
          label: '监听源',
          config: {
            sourceType: (initialData.sourceClientId !== undefined && initialData.sourceClientId !== null) ? 'client' : (initialData.sourceNodeId !== undefined && initialData.sourceNodeId !== null ? 'node' : 'node'),
            sourceNodeId: initialData.sourceNodeId,
            sourceDeviceId: initialData.sourceDeviceId,
            sourceClientId: initialData.sourceClientId,
            sourceWidgetName: initialData.sourceWidgetName,
            sourceGsiPath: initialData.sourceGsiPath,
            sourceGsiOperator: initialData.sourceGsiOperator,
            sourceGsiValue: initialData.sourceGsiValue,
            sourceClientType: initialData.sourceGsiPath ? 'gsi' : 'widget', // 根据是否有sourceGsiPath判断类型
            sourceAction: initialData.sourceAction,
            sourceNodeName: window.nodes?.find((n: any) => n.nid === initialData.sourceNodeId)?.name,
            sourceDeviceName: window.nodeDevicesMap?.[initialData.sourceNodeId]?.find((d: any) => d.deviceId === initialData.sourceDeviceId)?.name,
            sourceClientName: window.clients?.find((c: any) => c.clientId === initialData.sourceClientId)?.name,
          },
          onUpdate: (config: any) => {
            // 更新节点配置
            setNodes((nds) =>
              nds.map((node) =>
                node.id === 'source'
                  ? { ...node, data: { ...node.data, config } }
                  : node
              )
            );
          },
        },
      };
      nodes.push(sourceNode);

      // 触发效果节点
      const targets = initialData.targets || [];
      if (targets.length === 0 && initialData.targetNodeId) {
        // 兼容旧数据：单个 target
        targets.push({
          targetNodeId: initialData.targetNodeId,
          targetDeviceId: initialData.targetDeviceId || '',
          targetAction: initialData.targetAction || 'on',
          targetValue: initialData.targetValue,
        });
      }

      targets.forEach((target, index) => {
        const targetNode: Node = {
          id: `target-${index}`,
          type: 'target',
          position: { x: 400 + index * 250, y: 200 },
          data: {
            label: `触发效果 ${index + 1}`,
            config: {
              targetType: target.targetClientId ? 'client' : 'node',
              targetNodeId: target.targetNodeId,
              targetDeviceId: target.targetDeviceId,
              targetClientId: target.targetClientId,
              targetWidgetName: target.targetWidgetName,
              targetAction: target.targetAction,
              targetValue: target.targetValue,
              targetNodeName: window.nodes?.find((n: any) => n.nid === target.targetNodeId)?.name,
              targetDeviceName: window.nodeDevicesMap?.[target.targetNodeId]?.find((d: any) => d.deviceId === target.targetDeviceId)?.name,
              targetClientName: window.clients?.find((c: any) => c.clientId === target.targetClientId)?.name,
            },
            onUpdate: (config: any) => {
              setNodes((nds) =>
                nds.map((node) =>
                  node.id === `target-${index}`
                    ? { ...node, data: { ...node.data, config } }
                    : node
                )
              );
            },
            onDelete: () => {
              setNodes((nds) => nds.filter((node) => node.id !== `target-${index}`));
              setEdges((eds) => eds.filter((edge) => edge.target !== `target-${index}`));
            },
          },
        };
        nodes.push(targetNode);
      });
    } else {
      // 新建事件：只有监听源节点
      const sourceNode: Node = {
        id: 'source',
        type: 'source',
        position: { x: 100, y: 200 },
        data: {
          label: '监听源',
          config: {},
          onUpdate: (config: any) => {
            setNodes((nds) =>
              nds.map((node) =>
                node.id === 'source'
                  ? { ...node, data: { ...node.data, config } }
                  : node
              )
            );
          },
        },
      };
      nodes.push(sourceNode);
    }

    return nodes;
  }, [initialData]);

  const initialEdges = useMemo(() => {
    const edges: Edge[] = [];
    const nodes = initialNodes.filter((n) => n.id.startsWith('target-'));
    nodes.forEach((node, index) => {
      edges.push({
        id: `edge-source-${node.id}`,
        source: 'source',
        target: node.id,
        type: 'smoothstep',
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      });
    });
    return edges;
  }, [initialNodes]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 添加新的触发效果节点
  const handleAddTarget = useCallback(() => {
    const newId = `target-${Date.now()}`;
    const newTargetNode: Node = {
      id: newId,
      type: 'target',
      position: { x: 400 + nodes.filter((n) => n.type === 'target').length * 250, y: 200 },
      data: {
        label: `触发效果 ${nodes.filter((n) => n.type === 'target').length + 1}`,
        config: {},
        onUpdate: (config: any) => {
          setNodes((nds) =>
            nds.map((node) =>
              node.id === newId
                ? { ...node, data: { ...node.data, config } }
                : node
            )
          );
        },
        onDelete: () => {
          setNodes((nds) => nds.filter((node) => node.id !== newId));
          setEdges((eds) => eds.filter((edge) => edge.target !== newId));
        },
      },
    };
    setNodes((nds) => [...nds, newTargetNode]);
    setEdges((eds) => [
      ...eds,
      {
        id: `edge-source-${newId}`,
        source: 'source',
        target: newId,
        type: 'smoothstep',
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      },
    ]);
  }, [nodes, setNodes, setEdges]);

  // 连接处理
  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge(params, eds));
    },
    [setEdges]
  );

  // 保存事件
  const handleSave = useCallback(async () => {
    const sourceNode = nodes.find((n) => n.id === 'source');
    if (!sourceNode) {
      Notification.error('请配置监听源');
      return;
    }

    const sourceConfig = sourceNode.data.config;
    // 验证监听源配置
    // 优先根据实际数据判断类型，而不是依赖 sourceType
    const hasClientId = sourceConfig.sourceClientId !== undefined && sourceConfig.sourceClientId !== null;
    const hasGsiPath = sourceConfig.sourceGsiPath !== undefined && sourceConfig.sourceGsiPath !== null && sourceConfig.sourceGsiPath !== '';
    const hasNodeId = sourceConfig.sourceNodeId !== undefined && sourceConfig.sourceNodeId !== null;
    
    if (hasClientId) {
      // Client类型监听源
      // 优先判断GSI：如果有sourceGsiPath，或者sourceClientType是'gsi'，就认为是GSI类型
      // 注意：如果sourceClientType是'gsi'，即使sourceGsiPath为空，也应该认为是GSI类型
      const isGsiType = hasGsiPath || sourceConfig.sourceClientType === 'gsi';
      if (isGsiType) {
        // GSI数据监听
        if (!sourceConfig.sourceClientId) {
          Notification.error('请配置监听源（Client）');
          return;
        }
        if (!sourceConfig.sourceGsiPath || sourceConfig.sourceGsiPath === '') {
          Notification.error('请配置监听源（GSI字段）');
          return;
        }
        // 操作符有默认值 'eq'，所以这里不需要强制验证
        // 但为了明确，我们仍然检查，如果为空则使用默认值
        const operator = sourceConfig.sourceGsiOperator || 'eq';
        if (sourceConfig.sourceGsiValue === undefined || sourceConfig.sourceGsiValue === null || sourceConfig.sourceGsiValue === '') {
          Notification.error('请选择或输入比较值');
          return;
        }
      } else {
        // 组件状态监听
        if (!sourceConfig.sourceClientId) {
          Notification.error('请配置监听源（Client）');
          return;
        }
        if (!sourceConfig.sourceWidgetName) {
          Notification.error('请配置监听源（组件）');
          return;
        }
      }
    } else if (hasNodeId) {
      // Node设备监听
      if (!sourceConfig.sourceNodeId || !sourceConfig.sourceDeviceId) {
        Notification.error('请配置监听源（节点和设备）');
        return;
      }
    } else {
      // 无法确定类型
      Notification.error('请配置监听源');
      return;
    }

    const targetNodes = nodes.filter((n) => n.type === 'target');
    if (targetNodes.length === 0) {
      Notification.error('请至少添加一个触发效果');
      return;
    }

    // 验证每个触发效果节点
    for (let i = 0; i < targetNodes.length; i++) {
      const node = targetNodes[i];
      const targetConfig = node.data.config || {};
      const targetType = targetConfig.targetType || (targetConfig.targetClientId ? 'client' : 'node');
      
      // 调试信息
      console.log(`Target ${i + 1} config:`, {
        targetType,
        targetClientId: targetConfig.targetClientId,
        targetWidgetName: targetConfig.targetWidgetName,
        targetNodeId: targetConfig.targetNodeId,
        targetDeviceId: targetConfig.targetDeviceId,
        targetAction: targetConfig.targetAction,
        fullConfig: targetConfig,
      });
      
      if (targetType === 'client') {
        if (!targetConfig.targetClientId || !targetConfig.targetWidgetName) {
          Notification.error(`请配置第 ${i + 1} 个触发效果（Client和组件），并点击"保存"按钮`);
          return;
        }
      } else {
        if (!targetConfig.targetNodeId || !targetConfig.targetDeviceId) {
          Notification.error(`请配置第 ${i + 1} 个触发效果（节点和设备），并点击"保存"按钮`);
          return;
        }
      }
      // 验证动作：如果为空字符串、null或undefined，都认为是未配置
      if (!targetConfig.targetAction || targetConfig.targetAction === '') {
        console.error(`Target ${i + 1} action is missing:`, targetConfig.targetAction);
        Notification.error(`请配置第 ${i + 1} 个触发效果的动作，并点击"保存"按钮`);
        return;
      }
    }

    const targets: TargetAction[] = targetNodes.map((node, index) => {
      const targetConfig = node.data.config || {};
      const targetType = targetConfig.targetType || (targetConfig.targetClientId ? 'client' : 'node');
      
      // 调试信息
      console.log(`Building target ${index + 1}:`, {
        targetType,
        targetAction: targetConfig.targetAction,
        fullConfig: targetConfig,
      });
      
      if (targetType === 'client') {
        // Client组件类型：只发送Client相关字段，明确排除Node相关字段
        return {
          targetClientId: targetConfig.targetClientId,
          targetWidgetName: targetConfig.targetWidgetName,
          targetAction: targetConfig.targetAction || 'on',
          order: index,
          // 明确排除Node相关字段
          targetNodeId: undefined,
          targetDeviceId: undefined,
        };
      } else {
        // Node设备类型：只发送Node相关字段，明确排除Client相关字段
        return {
          targetNodeId: targetConfig.targetNodeId,
          targetDeviceId: targetConfig.targetDeviceId,
          targetAction: targetConfig.targetAction || 'on',
          targetValue: targetConfig.targetValue,
          order: index,
          // 明确排除Client相关字段
          targetClientId: undefined,
          targetWidgetName: undefined,
        };
      }
    });

    const eventData: any = {
      name: eventName,
      description: eventDescription,
      targets,
      enabled: eventEnabled,
      triggerLimit: triggerLimit === '' ? undefined : (triggerLimit === 0 ? 0 : triggerLimit),
      triggerDelay: triggerDelay === '' ? undefined : (triggerDelay === 0 ? 0 : triggerDelay),
    };

    // 根据源类型设置不同的字段
    if (sourceConfig.sourceType === 'client') {
      eventData.sourceClientId = sourceConfig.sourceClientId;
      if (sourceConfig.sourceClientType === 'gsi') {
        // GSI数据监听源：明确设置GSI相关字段，排除组件相关字段
        // 确保sourceGsiPath被发送，即使可能是空字符串
        eventData.sourceGsiPath = sourceConfig.sourceGsiPath || '';
        eventData.sourceGsiOperator = sourceConfig.sourceGsiOperator || 'eq';
        eventData.sourceGsiValue = sourceConfig.sourceGsiValue;
        // 明确排除组件相关字段（不发送这些字段）
        delete eventData.sourceWidgetName;
        delete eventData.sourceAction;
      } else {
        // Client组件监听源：明确设置组件相关字段，排除GSI相关字段
        eventData.sourceWidgetName = sourceConfig.sourceWidgetName;
        eventData.sourceAction = sourceConfig.sourceAction || '';
        // 明确排除GSI相关字段（不发送这些字段）
        delete eventData.sourceGsiPath;
        delete eventData.sourceGsiOperator;
        delete eventData.sourceGsiValue;
      }
    } else {
      // Node设备监听源
      eventData.sourceNodeId = sourceConfig.sourceNodeId;
      eventData.sourceDeviceId = sourceConfig.sourceDeviceId;
      eventData.sourceAction = sourceConfig.sourceAction || '';
      // 明确排除Client相关字段（不发送这些字段）
      delete eventData.sourceClientId;
      delete eventData.sourceWidgetName;
      delete eventData.sourceGsiPath;
      delete eventData.sourceGsiOperator;
      delete eventData.sourceGsiValue;
    }

    // 防止重复提交
    if (isSaving) {
      return;
    }
    setIsSaving(true);

    try {
      const domainId = window.domainId || 'system';
      const sceneId = window.sceneId;
      const url = eventId
        ? `/d/${domainId}/scene/${sceneId}/event/${eventId}/edit`
        : `/d/${domainId}/scene/${sceneId}/event/new/edit`;
      
      const response = await request.post(url, {
        operation: eventId ? 'update' : 'create',
        ...eventData,
      });

      if (response.error || response.message) {
        Notification.error(response.message || response.error || '操作失败');
        setIsSaving(false); // 失败时重置状态
        return; // 失败时不跳转
      } else {
        Notification.success(eventId ? '事件更新成功' : '事件创建成功');
        // 创建成功后立即跳转，避免重复提交
          window.location.href = `/d/${domainId}/scene/${sceneId}`;
        return; // 跳转后不需要继续执行
      }
    } catch (error: any) {
      Notification.error('保存失败: ' + (error.message || '未知错误'));
      setIsSaving(false); // 出错时重置状态
    }
  }, [nodes, eventName, eventDescription, eventEnabled, triggerLimit, triggerDelay, eventId, isSaving]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 表单头部 */}
      <div style={{ padding: '20px', background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>事件名称</label>
          <input
            type="text"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="请输入事件名称"
            style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
          />
        </div>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>说明</label>
          <textarea
            value={eventDescription}
            onChange={(e) => setEventDescription(e.target.value)}
            placeholder="请输入说明（可选）"
            style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '60px' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <input
              type="checkbox"
              checked={eventEnabled}
              onChange={(e) => setEventEnabled(e.target.checked)}
            />
            <span>启用此事件</span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '20px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ whiteSpace: 'nowrap' }}>触发次数限制:</span>
              <input
                type="number"
                value={triggerLimit}
                onChange={(e) => setTriggerLimit(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                placeholder="0=不限制"
                min="0"
                style={{ width: '80px', padding: '4px', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ whiteSpace: 'nowrap' }}>延时触发(ms):</span>
              <input
                type="number"
                value={triggerDelay}
                onChange={(e) => setTriggerDelay(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                placeholder="0=立即"
                min="0"
                style={{ width: '80px', padding: '4px', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </label>
          </div>
          <button
            onClick={handleAddTarget}
            style={{
              padding: '8px 16px',
              background: '#4caf50',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginLeft: 'auto',
            }}
          >
            + 添加触发效果
          </button>
        </div>
      </div>

      {/* ReactFlow 编辑器 */}
      <div ref={reactFlowWrapper} style={{ flex: 1, height: '100%' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setReactFlowInstance}
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

      {/* 操作按钮 */}
      <div style={{ padding: '15px', background: '#f5f5f5', borderTop: '1px solid #ddd', display: 'flex', gap: '10px' }}>
        <button
          onClick={handleSave}
          disabled={isSaving}
          style={{
            padding: '10px 20px',
            background: isSaving ? '#ccc' : '#2196f3',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: isSaving ? 'not-allowed' : 'pointer',
            fontWeight: 'bold',
            opacity: isSaving ? 0.6 : 1,
          }}
        >
          {isSaving ? '保存中...' : (eventId ? '更新' : '创建')} (Ctrl+Enter)
        </button>
        <button
          onClick={() => window.history.go(-1)}
          style={{
            padding: '10px 20px',
            background: '#f5f5f5',
            color: '#333',
            border: '1px solid #ddd',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

const page = new NamedPage('scene_event_edit', async () => {
  try {
    const container = document.getElementById('scene-event-editor');
    if (!container) {
      console.warn('Scene event editor container not found');
      return;
    }

    let eventId: number | undefined = undefined;
    const eventIdStr = container.dataset.eventId;
    if (eventIdStr && eventIdStr !== '') {
      const parsed = parseInt(eventIdStr, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        eventId = parsed;
      }
    }

    let initialData: SceneEventData | undefined = undefined;
    // 优先从 window.sceneEventData 获取（更可靠，避免 HTML 转义问题）
    const eventDataFromWindow = (window as any).sceneEventData;
    
    let parsed: any = null;
    if (eventDataFromWindow !== undefined && eventDataFromWindow !== null) {
      // 如果已经是对象，直接使用
      if (typeof eventDataFromWindow === 'object') {
        parsed = eventDataFromWindow;
      } else if (typeof eventDataFromWindow === 'string' && eventDataFromWindow !== '' && eventDataFromWindow !== '{}' && eventDataFromWindow !== 'null') {
        // 如果是字符串，尝试解析
        try {
          parsed = JSON.parse(eventDataFromWindow);
        } catch (e) {
          console.error('Failed to parse eventDataFromWindow string:', e);
        }
      }
    }
    
    // 如果没有从 window 获取到，尝试从 data 属性获取
    if (!parsed) {
      const initialDataStr = container.dataset.initialData;
      if (initialDataStr && initialDataStr !== '' && initialDataStr !== '{}') {
        try {
          parsed = JSON.parse(initialDataStr);
        } catch (parseError: any) {
          console.error('Failed to parse initial data from dataset:', parseError);
          console.error('Data string:', initialDataStr);
          // 尝试修复 HTML 实体
          try {
            const fixedStr = initialDataStr
              .replace(/&quot;/g, '"')
              .replace(/&#x27;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');
            parsed = JSON.parse(fixedStr);
          } catch (fixError) {
            console.error('Failed to parse even after fixing HTML entities:', fixError);
          }
        }
      }
    }
    
    // 如果成功解析到数据，进行验证和处理
    if (parsed && typeof parsed === 'object') {
      // 确保必要字段存在
      if (!parsed.name) parsed.name = '';
      // 保留所有源字段，不要覆盖它们
      // sourceClientId, sourceWidgetName, sourceNodeId, sourceDeviceId 都应该保留原值
      // 不需要额外处理，直接使用原值
      
      // 确保 targets 数组存在且格式正确
      if (!parsed.targets || !Array.isArray(parsed.targets)) {
        // 如果没有 targets，尝试从旧字段转换（向后兼容，但应该不会发生）
        if (parsed.targetNodeId && parsed.targetDeviceId && parsed.targetAction) {
          parsed.targets = [{
            targetNodeId: parsed.targetNodeId,
            targetDeviceId: parsed.targetDeviceId,
            targetAction: parsed.targetAction,
            targetValue: parsed.targetValue,
            order: 0,
          }];
        } else {
          parsed.targets = [];
        }
      }
      
      // 验证 targets 数组中的每个元素，保留 client 相关字段
      parsed.targets = parsed.targets.map((target: any, index: number) => ({
        targetNodeId: target.targetNodeId,
        targetDeviceId: target.targetDeviceId,
        targetClientId: target.targetClientId,
        targetWidgetName: target.targetWidgetName,
        targetAction: target.targetAction || '',
        targetValue: target.targetValue !== undefined ? target.targetValue : null,
        order: target.order !== undefined ? target.order : index,
      }));
      
      initialData = parsed;
    } else if (parsed === null || parsed === undefined) {
      // 没有数据，创建新事件
      initialData = undefined;
    } else {
      // 解析失败
      console.error('Invalid parsed data:', parsed);
      Notification.warn('解析事件数据失败，将创建新事件');
      initialData = undefined;
    }
    
    if (initialData) {
      console.log('Successfully loaded event data:', initialData);
      console.log('Source info:', {
        sourceClientId: initialData.sourceClientId,
        sourceWidgetName: initialData.sourceWidgetName,
        sourceNodeId: initialData.sourceNodeId,
        sourceDeviceId: initialData.sourceDeviceId,
        sourceAction: initialData.sourceAction,
      });
    } else {
      console.log('No event data found, creating new event');
    }

    // 确保 window 对象上的数据存在
    if (!window.nodeDevicesMap) {
      window.nodeDevicesMap = {};
    }
    if (!window.nodes) {
      window.nodes = [];
    }

    ReactDOM.render(
      <SceneEventEditor eventId={eventId} initialData={initialData} />,
      container
    );
  } catch (error: any) {
    console.error('Failed to initialize scene event editor:', error);
    Notification.error('初始化事件编辑器失败: ' + (error.message || '未知错误'));
  }
});

export default page;


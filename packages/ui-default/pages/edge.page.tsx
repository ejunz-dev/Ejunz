import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';

export default new AutoloadPage('edge_status,edge_main', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    const $statusWs = $('#edge-status-ws');
    if ($statusWs.length) {
        const domainId = $statusWs.data('domain-id');
        
        if (domainId) {
            // 连接状态 WebSocket
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            const wsUrl = `${protocol}//${host}/d/${domainId}/edge/status/ws`;
            
            let ws: any = null;
            let reconnectTimer: any = null;
            
            function connect() {
                if (ws && ws.readyState === WebSocket.OPEN) return;
                
                ws = new Sock(wsUrl, false, true);
                
                ws.onopen = function() {
                    console.log('Edge Status WebSocket connected');
                    if (reconnectTimer) {
                        clearInterval(reconnectTimer);
                        reconnectTimer = null;
                    }
                };
                
                ws.onmessage = function(msg: any, data: any) {
                    try {
                        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                        handleMessage(parsed);
                    } catch (e) {
                        console.error('Failed to parse WebSocket message:', e);
                    }
                };
                
                ws.onerror = function(error: any) {
                    console.error('Edge Status WebSocket error:', error);
                };
                
                ws.onclose = function() {
                    console.log('Edge Status WebSocket closed');
                    // 尝试重连
                    if (!reconnectTimer) {
                        reconnectTimer = setInterval(connect, 5000);
                    }
                };
            }
            
            function handleMessage(msg: any) {
                switch (msg.type) {
                case 'status/update':
                    updateStatuses(msg);
                    break;
                case 'pong':
                    // 心跳响应
                    break;
                }
            }
            
            function updateStatuses(data: any) {
                // 更新 MCP 状态
                if (data.mcp && Array.isArray(data.mcp)) {
                    updateStatusList('#edge-mcp-list', data.mcp, 'mcp');
                    updateTableStatus('mcp', data.mcp);
                }
                
                // 更新 Client 状态
                if (data.client && Array.isArray(data.client)) {
                    updateStatusList('#edge-client-list', data.client, 'client');
                    updateTableStatus('client', data.client);
                }
                
                // 更新 Node 状态
                if (data.node && Array.isArray(data.node)) {
                    updateStatusList('#edge-node-list', data.node, 'node');
                    updateTableStatus('node', data.node);
                }
            }
            
            function updateStatusList(selector: string, items: any[], type: string) {
                const $list = $(selector);
                if (!$list.length) return;
                
                items.forEach((item: any) => {
                    const $item = $list.find(`.edge-status-item[data-id="${item.id}"][data-type="${type}"]`);
                    if ($item.length) {
                        // 更新现有项的状态
                        const $status = $item.find('.edge-status-item__status');
                        $status.removeClass('edge-status--connected edge-status--disconnected edge-status--working')
                            .addClass(`edge-status--${item.status}`);
                        
                        const $icon = $status.find('.edge-status-icon');
                        $icon.removeClass('edge-status-icon--connected edge-status-icon--disconnected edge-status-icon--working')
                            .addClass(`edge-status-icon--${item.status}`);
                        
                        let statusText = '';
                        if (item.status === 'connected') {
                            statusText = '在线';
                        } else if (item.status === 'disconnected') {
                            statusText = '离线';
                        } else if (item.status === 'working') {
                            statusText = '工作中';
                        } else {
                            statusText = item.status;
                        }
                        
                        $status.contents().filter(function() {
                            return this.nodeType === 3; // 文本节点
                        }).last().replaceWith(statusText);
                    } else {
                        // 创建新项
                        const $newItem = $(`
                            <div class="edge-status-item" data-id="${item.id}" data-type="${type}">
                                <div class="edge-status-item__header">
                                    <span class="edge-status-item__name">${item.name || `${type} ${item.id}`}</span>
                                    <span class="edge-status-item__status edge-status--${item.status}">
                                        <span class="icon edge-status-icon edge-status-icon--${item.status}"></span>
                                        ${item.status === 'connected' ? '在线' : 
                                          item.status === 'disconnected' ? '离线' : 
                                          item.status === 'working' ? '工作中' : item.status}
                                    </span>
                                </div>
                            </div>
                        `);
                        $list.append($newItem);
                    }
                });
            }
            
            function updateTableStatus(type: string, items: any[]) {
                // 更新表格中的状态（用于 edge_main 页面，使用 record 样式系统）
                items.forEach((item: any) => {
                    // 查找表格行，根据 data-type 和 data-id 匹配
                    const $row = $(`.data-table tbody tr[data-type="${type}"][data-id="${item.id}"]`);
                    
                    if ($row && $row.length) {
                        // 查找状态列（第一列，class 为 col--status）
                        const $statusCell = $row.find('td.col--status');
                        if ($statusCell.length) {
                            // 将 edge 状态映射到 record 状态代码
                            let statusCode = 'pass'; // connected -> pass (绿色)
                            if (item.status === 'disconnected') {
                                statusCode = 'fail'; // disconnected -> fail (红色)
                            } else if (item.status === 'working') {
                                statusCode = 'progress'; // working -> progress (黄色)
                            }
                            
                            // 更新状态类（使用 record 的状态代码）
                            $statusCell.removeClass('pass fail progress')
                                .addClass(statusCode);
                            
                            // 更新状态文本区域
                            const $statusText = $statusCell.find('.col--status__text');
                            if ($statusText.length) {
                                // 更新图标（使用 record 的状态代码）
                                const $icon = $statusText.find('.record-status--icon');
                                if ($icon.length) {
                                    $icon.removeClass('pass fail progress')
                                        .addClass(statusCode);
                                }
                                
                                // 更新状态文本
                                const $statusTextSpan = $statusText.find('.record-status--text');
                                if ($statusTextSpan.length) {
                                    $statusTextSpan.removeClass('pass fail progress')
                                        .addClass(statusCode);
                                    
                                    let statusText = '';
                                    if (item.status === 'connected') {
                                        statusText = '在线';
                                    } else if (item.status === 'disconnected') {
                                        statusText = '离线';
                                    } else if (item.status === 'working') {
                                        statusText = '工作中';
                                    } else {
                                        statusText = item.status;
                                    }
                                    $statusTextSpan.text(statusText);
                                }
                            }
                            
                            // 更新进度条（如果是 working 状态）
                            const $progressContainer = $statusCell.find('.col--status__progress-container');
                            if (item.status === 'working') {
                                if (!$progressContainer.length) {
                                    $statusCell.append('<div class="col--status__progress-container"><div class="col--status__progress" style="width: 50%"></div></div>');
                                }
                            } else {
                                $progressContainer.remove();
                            }
                        }
                    }
                });
            }
            
            // 启动连接
            connect();
            
            // 定期发送心跳
            setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        }
    }
});


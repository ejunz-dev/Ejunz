import $ from 'jquery';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('client_detail', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    function deleteToken(clientId) {
        if (!confirm(i18n('Are you sure you want to delete the Token? Connections using this Token will be disconnected.'))) return;
        
        $.ajax({
            url: `/d/${(window.UiContext?.domainId || 'system')}/client/${clientId}/delete-token`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ clientId }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Token deleted successfully'));
                setTimeout(() => location.reload(), 1000);
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to delete Token: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    }

    function copyEndpoint() {
        const endpoint = $('#ws-endpoint').text();
        navigator.clipboard.writeText(endpoint).then(() => {
            Notification.success(i18n('Copied to clipboard'));
        }).catch(() => {
            Notification.error(i18n('Copy failed'));
        });
    }

    $(document).on('click', '.client-delete-token-btn', function() {
        const clientId = $(this).data('client-id');
        deleteToken(clientId);
    });

    $(document).on('click', '.client-copy-endpoint-btn', copyEndpoint);

    $(document).on('submit', '.client-delete-form', function(e) {
        if (!confirm(i18n('Are you sure you want to delete this client?'))) {
            e.preventDefault();
        }
    });

    // Real-time status updates for client detail page
    const $statusWs = $('#client-status-ws');
    if ($statusWs.length) {
        const clientId = $statusWs.data('client-id');
        const domainId = $statusWs.data('domain-id');
        
        if (clientId && domainId) {
            // Connect status WebSocket
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            const wsUrl = `${protocol}//${host}/d/${domainId}/client/status/ws?clientId=${clientId}`;
            
            let ws = null;
            let reconnectTimer = null;
            
            function connect() {
                if (ws && ws.readyState === WebSocket.OPEN) return;
                
                ws = new Sock(wsUrl, false, true);
                
                ws.onopen = function() {
                    console.log('Client Status WebSocket connected');
                    if (reconnectTimer) {
                        clearInterval(reconnectTimer);
                        reconnectTimer = null;
                    }
                };
                
                ws.onmessage = function(msg, data) {
                    try {
                        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                        handleMessage(parsed);
                    } catch (e) {
                        console.error('Failed to parse WebSocket message:', e);
                    }
                };
                
                ws.onerror = function(error) {
                    console.error('Client Status WebSocket error:', error);
                };
                
                ws.onclose = function() {
                    console.log('Client Status WebSocket closed');
                    // Try to reconnect
                    if (!reconnectTimer) {
                        reconnectTimer = setInterval(connect, 5000);
                    }
                };
            }
            
            function handleMessage(msg) {
                switch (msg.type) {
                case 'init':
                case 'refresh':
                    if (msg.client) updateClientStatus(msg.client);
                    break;
                case 'client/status':
                    if (msg.client) updateClientStatus(msg.client);
                    break;
                case 'pong':
                    // Heartbeat response
                    break;
                }
            }
            
            function updateClientStatus(client) {
                const statusText = client.status === 'connected' ? i18n('Connected') : 
                                  client.status === 'disconnected' ? i18n('Disconnected') : 
                                  client.status === 'error' ? i18n('Error') : client.status;
                
                // Update status display (all status elements)
                $('.client-status').each(function() {
                    const $el = $(this);
                    $el.removeClass('client-status-connected client-status-disconnected client-status-error')
                        .addClass(`client-status-${client.status}`)
                        .text(statusText);
                });
                
                // Update status indicator (badge)
                const $badge = $('#client-status-badge');
                if ($badge.length) {
                    $badge.removeClass('client-status-badge-connected client-status-badge-disconnected client-status-badge-error')
                        .addClass(`client-status-badge-${client.status}`);
                }
                
                // Update header status
                const $headerStatus = $('.section__header .client-status');
                if ($headerStatus.length) {
                    $headerStatus.removeClass('client-status-connected client-status-disconnected client-status-error')
                        .addClass(`client-status-${client.status}`)
                        .text(statusText);
                }
            }
            
            // Send heartbeat
            setInterval(function() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
            
            connect();
        }
    }

    // Widget control for client detail page
    const $widgetControlsContainer = $('#widget-controls-container');
    // 存储组件列表和状态（在外部定义，以便 sendControlCommand 可以访问）
    let widgets = [];
    let widgetStates = {}; // widgetName -> visible

    if ($widgetControlsContainer.length) {
        // 渲染组件控制UI
        function renderWidgets() {
            if (widgets.length === 0) {
                $widgetControlsContainer.html('<p class="text-gray">' + i18n('Waiting for widget list...') + '</p>');
                return;
            }

            let html = '<div class="widget-controls-grid">';
            widgets.forEach(widget => {
                const widgetName = typeof widget === 'string' ? widget : widget.name;
                const widgetLabel = typeof widget === 'string' ? widget : (widget.label || widget.name);
                const isVisible = widgetStates[widgetName] === true;
                
                html += `
                    <div class="widget-control-item">
                        <div class="switch-control">
                            <span class="switch-text">${widgetLabel}</span>
                            <label class="switch-label">
                                <input type="checkbox" class="widget-switch-toggle" 
                                    data-widget-name="${widgetName}"
                                    id="widget-${widgetName}"
                                    ${isVisible ? 'checked' : ''}>
                                <span class="switch-slider"></span>
                            </label>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            $widgetControlsContainer.html(html);
        }

        // 通过Status WebSocket接收组件列表和状态更新
        const $statusWs = $('#client-status-ws');
        if ($statusWs.length) {
            const clientId = $statusWs.data('client-id');
            const domainId = $statusWs.data('domain-id');
            
            if (clientId && domainId) {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const host = window.location.host;
                const wsUrl = `${protocol}//${host}/d/${domainId}/client/status/ws?clientId=${clientId}`;
                
                let statusWs = null;
                
                function connectStatusWs() {
                    if (statusWs && statusWs.sock?.readyState === WebSocket.OPEN) return;
                    
                    statusWs = new Sock(wsUrl, false, true);
                    
                    statusWs.onmessage = function(msg, data) {
                        try {
                            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                            handleStatusMessage(parsed);
                        } catch (e) {
                            console.error('Failed to parse status WebSocket message:', e);
                        }
                    };
                }

                function handleStatusMessage(msg) {
                    // 检查是否有组件列表信息
                    let receivedWidgets = null;
                    if (msg.widgets && Array.isArray(msg.widgets)) {
                        receivedWidgets = msg.widgets;
                    } else if (msg.payload?.widgets && Array.isArray(msg.payload.widgets)) {
                        receivedWidgets = msg.payload.widgets;
                    } else if (msg.type === 'widgets' && Array.isArray(msg.data)) {
                        receivedWidgets = msg.data;
                    } else if (msg.type === 'widget-list' && Array.isArray(msg.widgets)) {
                        receivedWidgets = msg.widgets;
                    }

                    if (receivedWidgets && receivedWidgets.length > 0) {
                        console.log('Received widget list:', receivedWidgets);
                        widgets = receivedWidgets;
                        renderWidgets();
                    }

                    // 检查是否有组件状态更新（批量）
                    if (msg.type === 'widget-states' && msg.states && typeof msg.states === 'object') {
                        widgetStates = { ...widgetStates, ...msg.states };
                        // 更新所有开关状态
                        Object.keys(msg.states).forEach(widgetName => {
                            const $toggle = $(`#widget-${widgetName}`);
                            if ($toggle.length) {
                                $toggle.prop('checked', msg.states[widgetName] === true);
                            }
                        });
                    }
                    
                    // 检查是否有单个组件状态更新
                    if (msg.type === 'widget-state-update' && msg.widgetName && typeof msg.visible === 'boolean') {
                        widgetStates[msg.widgetName] = msg.visible;
                        const $toggle = $(`#widget-${msg.widgetName}`);
                        if ($toggle.length) {
                            $toggle.prop('checked', msg.visible === true);
                        }
                    }
                    
                }

                connectStatusWs();
            }
        }
    }
    
    // GSI字段列表展示
    const $gsiFieldsContainer = $('#gsi-fields-container');
    if ($gsiFieldsContainer.length) {
        const $clientStatusWs = $('#client-status-ws');
        const clientId = $clientStatusWs.data('client-id') || window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        
        // 从API加载GSI字段列表
        function loadGsiFields() {
            if (!clientId) {
                $gsiFieldsContainer.html('<p class="text-gray">无法获取客户端ID</p>');
                return;
            }
            
            const domainId = $clientStatusWs.data('domain-id') || (window.UiContext?.domainId || 'system');
            $.get(`/d/${domainId}/client/${clientId}/gsi/fields`)
                .done((data) => {
                    if (data.fields && data.fields.length > 0) {
                        renderFieldList(data.fields);
                    } else {
                        $gsiFieldsContainer.html('<p class="text-gray">暂无GSI字段数据，请等待客户端连接并完成握手</p>');
                    }
                })
                .fail((xhr) => {
                    if (xhr.status === 404) {
                        $gsiFieldsContainer.html('<p class="text-gray">暂无GSI字段数据，请等待客户端连接并完成握手</p>');
                    } else {
                        $gsiFieldsContainer.html('<p class="text-red">加载GSI字段失败</p>');
                    }
                });
        }
        
        // 渲染字段列表
        function renderFieldList(fields) {
            let html = '<div class="gsi-field-list-content">';
            html += '<table class="data-table" style="width: 100%; font-size: 0.9em; table-layout: auto;">';
            html += '<thead><tr><th style="width: 25%;">字段路径</th><th style="width: 8%;">类型</th><th style="width: 35%; min-width: 200px;">可监听的值</th><th style="width: 32%;">说明</th></tr></thead>';
            html += '<tbody>';
            
            fields.forEach(field => {
                let desc = field.description || '';
                if (field.range && field.range.length === 2) {
                    desc += ` (范围: ${field.range[0]}-${field.range[1]})`;
                }
                if (field.nullable) {
                    desc += ' (可为null)';
                }
                
                // 显示可监听的值
                let valuesDisplay = '-';
                if (field.values && field.values.length > 0) {
                    // 显示所有可监听的值，每个值可点击复制，允许换行
                    valuesDisplay = field.values.map(val => {
                        const escapedVal = String(val).replace(/"/g, '&quot;');
                        return `<code class="gsi-field-value-item" style="background: #e8f5e9; padding: 2px 6px; border-radius: 3px; color: #2e7d32; font-weight: 500; cursor: pointer; margin: 2px 4px 2px 0; display: inline-block; white-space: nowrap;" 
                            data-path="${field.path.replace(/"/g, '&quot;')}" 
                            data-value="${escapedVal}">${val}</code>`;
                    }).join('');
                } else if (field.type === 'number' && field.range && field.range.length === 2) {
                    // 数值类型且有范围，显示范围提示
                    valuesDisplay = `<span style="color: #666;">范围: ${field.range[0]} - ${field.range[1]}</span>`;
                } else if (field.type === 'boolean') {
                    // 布尔类型，显示 true/false
                    valuesDisplay = `<code class="gsi-field-value-item" style="background: #e8f5e9; padding: 2px 6px; border-radius: 3px; color: #2e7d32; font-weight: 500; cursor: pointer; margin: 2px; display: inline-block;" 
                        data-path="${field.path.replace(/"/g, '&quot;')}" 
                        data-value="true">true</code> 
                        <code class="gsi-field-value-item" style="background: #e8f5e9; padding: 2px 6px; border-radius: 3px; color: #2e7d32; font-weight: 500; cursor: pointer; margin: 2px; display: inline-block;" 
                        data-path="${field.path.replace(/"/g, '&quot;')}" 
                        data-value="false">false</code>`;
                } else {
                    valuesDisplay = '<span style="color: #999;">任意值</span>';
                }
                
                html += `<tr>
                    <td style="vertical-align: top; padding: 8px;"><code class="gsi-field-path" style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px; cursor: pointer;" 
                        data-path="${field.path.replace(/"/g, '&quot;')}">${field.path}</code></td>
                    <td style="vertical-align: top; padding: 8px;"><span style="color: #666;">${field.type}</span></td>
                    <td style="vertical-align: top; padding: 8px; word-wrap: break-word; line-height: 1.8;">${valuesDisplay}</td>
                    <td style="vertical-align: top; padding: 8px;"><span style="color: #666;">${desc || '-'}</span></td>
                </tr>`;
            });
            
            html += '</tbody></table>';
            html += '<div style="margin-top: 15px; padding: 10px; background: #f9f9f9; border-radius: 4px; font-size: 0.85em; color: #666;">';
            html += '<strong>提示：</strong>点击字段路径可复制路径，点击可监听的值可复制该值。这些字段和值由客户端在握手时注册，可用于场景事件系统中作为监听源和条件值。';
            html += '</div>';
            html += '</div>';
            $gsiFieldsContainer.html(html);
        }
        
        // 初始化加载
        loadGsiFields();
        
        // 绑定字段路径复制事件（使用事件委托）
        $(document).on('click', '.gsi-field-path', function() {
            const path = $(this).data('path');
            if (path) {
                navigator.clipboard.writeText(path).then(() => {
                    Notification.success('已复制字段路径: ' + path);
                }).catch(() => {
                    Notification.error('复制失败');
                });
            }
        });
        
        // 绑定可监听值复制事件
        $(document).on('click', '.gsi-field-value-item', function() {
            const value = $(this).data('value');
            const path = $(this).data('path');
            if (value !== undefined && value !== null && value !== '') {
                navigator.clipboard.writeText(String(value)).then(() => {
                    Notification.success(`已复制监听值: ${path} = ${value}`);
                }).catch(() => {
                    Notification.error('复制失败');
                });
            }
        });
    }

    function sendControlCommand(widgetName, visible) {
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) {
            Notification.error(i18n('Client ID not found'));
            return;
        }
        
        const domainId = (window.UiContext?.domainId || 'system');
        
        $.ajax({
            url: `/d/${domainId}/client/${clientId}/widget/control`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                widgetName: widgetName,
                visible: visible
            }),
        }).then((response) => {
            if (response.success) {
                console.log('Widget control command sent successfully:', response);
                // 乐观更新UI
                widgetStates[widgetName] = visible;
                const $toggle = $(`#widget-${widgetName}`);
                if ($toggle.length) {
                    $toggle.prop('checked', visible);
                }
            } else {
                Notification.error(i18n('Widget control failed: {0}').replace('{0}', response.error || response.message || 'Unknown error'));
            }
        }).catch((error) => {
            console.error('Failed to send control command:', error);
            Notification.error(i18n('Failed to send control command: {0}').replace('{0}', error.responseJSON?.error || error.message || 'Unknown error'));
        });
    }

    // 绑定开关事件（使用事件委托，因为组件是动态生成的）
    $(document).on('change', '.widget-switch-toggle', function() {
        const $toggle = $(this);
        const widgetName = $toggle.data('widget-name');
        const isChecked = $toggle.is(':checked');
        
        console.log('Widget toggle changed:', { widgetName, isChecked });
        
        if (widgetName) {
            sendControlCommand(widgetName, isChecked);
        } else {
            console.error('Missing widget name');
        }
    });
});


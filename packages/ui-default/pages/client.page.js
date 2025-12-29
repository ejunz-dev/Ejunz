import $ from 'jquery';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('client_domain,client_detail', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    // Token 生成功能已迁移到 edge 页面

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

    function copyBaseEndpoint() {
        const endpoint = $('#client-endpoint-base').text();
        navigator.clipboard.writeText(endpoint).then(() => {
            Notification.success(i18n('Copied to clipboard'));
        }).catch(() => {
            Notification.error(i18n('Copy failed'));
        });
    }

    // Token 生成按钮已移除，请使用 edge 页面生成

    $(document).on('click', '.client-delete-token-btn', function() {
        const clientId = $(this).data('client-id');
        deleteToken(clientId);
    });

    $(document).on('click', '.client-copy-endpoint-btn', copyEndpoint);
    $(document).on('click', '.client-copy-base-endpoint-btn', copyBaseEndpoint);

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
    if ($widgetControlsContainer.length) {
        // 存储组件列表和状态
        let widgets = [];
        let widgetStates = {}; // widgetName -> visible

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

                    // 检查是否有组件状态更新
                    if (msg.widgetStates && typeof msg.widgetStates === 'object') {
                        widgetStates = { ...widgetStates, ...msg.widgetStates };
                        // 更新所有开关状态
                        Object.keys(widgetStates).forEach(widgetName => {
                            const $toggle = $(`#widget-${widgetName}`);
                            if ($toggle.length) {
                                $toggle.prop('checked', widgetStates[widgetName] === true);
                            }
                        });
                    }
                }

                connectStatusWs();
            }
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

        // 初始渲染（空列表）
        renderWidgets();
    }
});


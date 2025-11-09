import $ from 'jquery';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';

export default new AutoloadPage('mcp_domain,mcp_detail', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    // Token 管理功能
    function generateToken(serverId, domainId) {
        if (!confirm('确定要生成新的 Token 吗？旧的 Token 将失效。')) return;
        
        $.ajax({
            url: `/mcp/${serverId}/generate-token`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ serverId }),
        }).then((response) => {
            if (response.wsToken) {
                $('#ws-token').text(response.wsToken);
                // 构建 WebSocket URL
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const host = window.location.host;
                const wsPath = `/d/${domainId}/mcp/ws`;
                const endpoint = `${protocol}//${host}${wsPath}?token=${response.wsToken}`;
                $('#ws-endpoint').text(endpoint);
                if ($('.endpoint-url').length === 0) {
                    $('.token-info').append(`<div class="endpoint-url"><code id="ws-endpoint">${endpoint}</code><button class="button small mcp-copy-endpoint-btn">复制</button></div>`);
                }
                if ($('.token-info').length === 0) {
                    $('.section__body').prepend(`<div class="token-info"><p><strong>Token:</strong> <code id="ws-token">${response.wsToken}</code></p></div>`);
                }
                Notification.success('Token 已生成');
                setTimeout(() => location.reload(), 1000);
            }
        }).catch((error) => {
            Notification.error('生成 Token 失败: ' + (error.responseJSON?.error || error.message || '未知错误'));
        });
    }

    function deleteToken(serverId) {
        if (!confirm('确定要删除 Token 吗？使用此 Token 的连接将断开。')) return;
        
        $.ajax({
            url: `/mcp/${serverId}/delete-token`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ serverId }),
        }).then((response) => {
            if (response.success) {
                Notification.success('Token 已删除');
                setTimeout(() => location.reload(), 1000);
            }
        }).catch((error) => {
            Notification.error('删除 Token 失败: ' + (error.responseJSON?.error || error.message || '未知错误'));
        });
    }

    function copyEndpoint() {
        const endpoint = $('#ws-endpoint').text();
        navigator.clipboard.writeText(endpoint).then(() => {
            Notification.success('已复制到剪贴板');
        }).catch(() => {
            Notification.error('复制失败');
        });
    }

    function copyBaseEndpoint() {
        const endpoint = $('#mcp-endpoint-base').text();
        navigator.clipboard.writeText(endpoint).then(() => {
            Notification.success('已复制到剪贴板');
        }).catch(() => {
            Notification.error('复制失败');
        });
    }

    // 绑定 Token 管理按钮事件
    $(document).on('click', '.mcp-generate-token-btn', function() {
        const serverId = $(this).data('server-id');
        const domainId = $(this).data('domain-id');
        generateToken(serverId, domainId);
    });

    $(document).on('click', '.mcp-delete-token-btn', function() {
        const serverId = $(this).data('server-id');
        deleteToken(serverId);
    });

    $(document).on('click', '.mcp-copy-endpoint-btn', copyEndpoint);
    $(document).on('click', '.mcp-copy-base-endpoint-btn', copyBaseEndpoint);

    $(document).on('submit', '.mcp-delete-form', function(e) {
        if (!confirm('确定要删除此 MCP 服务器吗？')) {
            e.preventDefault();
        }
    });

    // 手动刷新工具列表
    function refreshTools(serverId, domainId) {
        $.ajax({
            url: `/mcp/${serverId}/refresh-tools`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ serverId }),
        }).then((response) => {
            if (response.success) {
                Notification.success(response.message || '已发送工具列表刷新请求');
                // 等待一段时间后刷新页面以显示新工具
                setTimeout(() => {
                    location.reload();
                }, 2000);
            } else {
                Notification.error(response.error || '刷新工具列表失败');
            }
        }).catch((error) => {
            Notification.error('刷新工具列表失败: ' + (error.responseJSON?.error || error.message || '未知错误'));
        });
    }

    $(document).on('click', '.mcp-refresh-tools-btn', function() {
        const serverId = $(this).data('server-id');
        const domainId = $(this).data('domain-id');
        if (serverId && domainId) {
            refreshTools(serverId, domainId);
        }
    });

    // MCP 详情页面的实时状态更新
    const $statusWs = $('#mcp-status-ws');
    if ($statusWs.length) {
        const serverId = $statusWs.data('server-id');
        const domainId = $statusWs.data('domain-id');
        
        if (serverId && domainId) {
            // 连接状态 WebSocket
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            const wsUrl = `${protocol}//${host}/d/${domainId}/mcp/status/ws?serverId=${serverId}`;
            
            let ws = null;
            let reconnectTimer = null;
            
            function connect() {
                if (ws && ws.readyState === WebSocket.OPEN) return;
                
                ws = new Sock(wsUrl, false, true);
                
                ws.onopen = function() {
                    console.log('MCP Status WebSocket connected');
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
                    console.error('MCP Status WebSocket error:', error);
                };
                
                ws.onclose = function() {
                    console.log('MCP Status WebSocket closed');
                    // 尝试重连
                    if (!reconnectTimer) {
                        reconnectTimer = setInterval(connect, 5000);
                    }
                };
            }
            
            function handleMessage(msg) {
                switch (msg.type) {
                case 'init':
                case 'refresh':
                    if (msg.server) updateServerStatus(msg.server);
                    if (msg.tools) updateToolsList(msg.tools);
                    break;
                case 'server/status':
                    if (msg.server) updateServerStatus(msg.server);
                    break;
                case 'tools/update':
                    if (msg.tools) updateToolsList(msg.tools);
                    break;
                case 'pong':
                    // 心跳响应
                    break;
                }
            }
            
            function updateServerStatus(server) {
                // 更新状态显示
                const $statusEl = $('.server-status');
                if ($statusEl.length) {
                    $statusEl.removeClass('server-status-connected server-status-disconnected server-status-error')
                        .addClass(`server-status-${server.status}`);
                    $statusEl.text(server.status === 'connected' ? '已连接' : 
                                   server.status === 'disconnected' ? '已断开' : 
                                   server.status === 'error' ? '错误' : server.status);
                }
                
                // 更新工具数量
                const $toolsCountEl = $('table.data-table tr').filter(function() {
                    return $(this).find('th').text() === '工具数量';
                }).find('td');
                if ($toolsCountEl.length) {
                    $toolsCountEl.text(server.toolsCount || 0);
                }
            }
            
            function updateToolsList(tools) {
                if (!tools || !Array.isArray(tools)) return;
                
                const $toolsSection = $('.tools-section');
                if (!$toolsSection.length) return;
                
                const $toolsList = $toolsSection.find('.tools-list');
                const $emptyMessage = $toolsSection.find('p.text-gray');
                
                if (tools.length === 0) {
                    // 如果没有工具，显示空消息
                    if ($toolsList.length) {
                        $toolsList.remove();
                    }
                    if (!$emptyMessage.length) {
                        $toolsSection.append('<p class="text-gray">暂无工具。服务器连接后会自动同步工具列表。</p>');
                    }
                    Notification.info('工具列表已清空');
                    return;
                }
                
                // 移除空消息
                $emptyMessage.remove();
                
                // 构建工具列表HTML
                let toolsHtml = '<div class="tools-list">';
                for (const tool of tools) {
                    const schemaJson = tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : '';
                    toolsHtml += `
                        <div class="tool-card">
                            <div class="tool-header">
                                <h4 class="tool-name">${escapeHtml(tool.name)}</h4>
                                <span class="tool-id">ID: ${tool.toolId}</span>
                            </div>
                            <div class="tool-description">
                                <p>${escapeHtml(tool.description || '')}</p>
                            </div>
                            ${schemaJson ? `
                                <div class="tool-schema">
                                    <strong>输入模式：</strong>
                                    <pre><code>${escapeHtml(schemaJson)}</code></pre>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }
                toolsHtml += '</div>';
                
                // 更新DOM
                if ($toolsList.length) {
                    $toolsList.replaceWith(toolsHtml);
                } else {
                    $toolsSection.append(toolsHtml);
                }
                
                Notification.success(`工具列表已更新，共 ${tools.length} 个工具`);
            }
            
            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            
            // 发送心跳
            setInterval(function() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
            
            connect();
        }
    }

    // MCP 列表页面的实时更新
    const $domainPage = $('.mcp-server-list');
    if ($domainPage.length) {
        const domainId = $domainPage.data('domain-id');
        
        if (domainId) {
            // 可以在这里添加列表页面的实时更新逻辑
            // 例如：定期刷新服务器列表或使用 WebSocket 推送更新
        }
    }
});


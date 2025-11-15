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
            url: `/client/${clientId}/delete-token`,
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

    // Settings tab switching
    $('.settings-tab').on('click', function() {
        const tab = $(this).data('tab');
        $('.settings-tab').removeClass('active');
        $(this).addClass('active');
        $('.settings-panel').removeClass('active');
        $(`#settings-${tab}`).addClass('active');
    });

    // ASR configuration save
    $('#asr-settings-form').on('submit', function(e) {
        e.preventDefault();
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;

        const formData = {};
        $(this).serializeArray().forEach(item => {
            if (item.name === 'enableServerVad') {
                formData[item.name] = $(`input[name="${item.name}"]`).is(':checked');
            } else {
                formData[item.name] = item.value;
            }
        });

        $.ajax({
            url: `/client/${clientId}/update-settings`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ asr: formData }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('ASR configuration saved successfully'));
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to save ASR configuration: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    });

    // TTS configuration save
    $('#tts-settings-form').on('submit', function(e) {
        e.preventDefault();
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;

        const formData = {};
        $(this).serializeArray().forEach(item => {
            formData[item.name] = item.value;
        });

        $.ajax({
            url: `/client/${clientId}/update-settings`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ tts: formData }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('TTS configuration saved successfully'));
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to save TTS configuration: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    });

    // Agent configuration save
    $('#agent-settings-form').on('submit', function(e) {
        e.preventDefault();
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;

        const agentId = $('select[name="agentId"]').val();
        const agentData = agentId ? { agentId } : undefined;

        $.ajax({
            url: `/client/${clientId}/update-settings`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ agent: agentData }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Agent configuration saved successfully'));
                setTimeout(() => location.reload(), 1000);
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to save Agent configuration: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    });

    $('#clear-agent-btn').on('click', function() {
        if (!confirm(i18n('Are you sure you want to clear the Agent configuration?'))) return;
        
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;

        $.ajax({
            url: `/client/${clientId}/update-settings`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ agent: undefined }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Agent configuration cleared successfully'));
                setTimeout(() => location.reload(), 1000);
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to clear Agent configuration: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
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
});


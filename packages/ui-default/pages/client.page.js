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

    // Settings tab switching
    $('.settings-tab').on('click', function() {
        const tab = $(this).data('tab');
        $('.settings-tab').removeClass('active');
        $(this).addClass('active');
        $('.settings-panel').removeClass('active');
        $(`#settings-${tab}`).addClass('active');
    });

    // ASR model selection
    $('#asr-model-select').on('change', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            $('#asr-config-options').slideDown();
        } else {
            $('#asr-config-options').slideUp();
        }
    });

    // TTS model selection
    $('#tts-model-select').on('change', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            $('#tts-config-options').slideDown();
            // 如果选择的是声音复刻模型，显示特殊提示和声音复刻配置
            if (selectedModel === 'qwen3-tts-vc-realtime-2025-11-27') {
                $('#voice-help-default').hide();
                $('#voice-help-vc').show();
                $('#voice-cloning-section').slideDown();
                loadVoiceList();
            } else {
                $('#voice-help-default').show();
                $('#voice-help-vc').hide();
                $('#voice-cloning-section').slideUp();
                updateVoiceSelect([]);
            }
        } else {
            $('#tts-config-options').slideUp();
            $('#voice-cloning-section').slideUp();
        }
    });
    
    // 初始化时检查当前选择的模型
    const initialModel = $('#tts-model-select').val();
    const currentVoice = $('#tts-voice-input').val();
    
    if (initialModel === 'qwen3-tts-vc-realtime-2025-11-27') {
        $('#voice-help-default').hide();
        $('#voice-help-vc').show();
        $('#voice-cloning-section').show();
        loadVoiceList();
    } else {
        $('#voice-cloning-section').hide();
        // 非声音复刻模型，初始化voice选择
        if (currentVoice && currentVoice !== 'Cherry') {
            $('#tts-voice-select').hide();
            $('#tts-voice-input').show();
        } else {
            $('#tts-voice-select').show();
            $('#tts-voice-input').hide();
        }
    }

    // 加载音色列表
    function loadVoiceList() {
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;
        
        const domainId = (window.UiContext?.domainId || 'system');
        
        $.ajax({
            url: `/d/${domainId}/client/${clientId}/voices`,
            method: 'GET',
        }).then((response) => {
            if (response.success) {
                renderVoiceList(response.voices || []);
                updateVoiceSelect(response.voices || []);
            }
        }).catch((error) => {
            $('#voice-list-container').html('<p class="text-danger">' + i18n('Failed to load voices: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')) + '</p>');
        });
    }

    // 渲染音色列表
    function renderVoiceList(voices) {
        const container = $('#voice-list-container');
        if (voices.length === 0) {
            container.html('<p class="help-text">' + i18n('No cloned voices yet. Create one above.') + '</p>');
            return;
        }

        let html = '<div class="voice-list">';
        voices.forEach((voice) => {
            const createdAt = new Date(voice.createdAt).toLocaleString();
            html += `
                <div class="voice-item" data-voice-id="${voice.voiceId}" style="padding: 15px; margin-bottom: 10px; border: 1px solid #e0e0e0; border-radius: 4px; background: #f9f9f9;">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="flex: 1;">
                            <strong>${voice.preferredName || voice.voiceId}</strong>
                            <br>
                            <code style="font-size: 0.9em; color: #666;">${voice.voiceId}</code>
                            <br>
                            <span style="font-size: 0.85em; color: #999;">${i18n('Created')}: ${createdAt} | ${i18n('Region')}: ${voice.region}</span>
                        </div>
                        <div>
                            <button class="button small select-voice-btn" data-voice-id="${voice.voiceId}" style="margin-right: 5px;">${i18n('Select')}</button>
                            <button class="button small edit-voice-btn" data-voice-id="${voice.voiceId}" data-preferred-name="${voice.preferredName || ''}" style="margin-right: 5px;">${i18n('Edit')}</button>
                            <button class="button small danger delete-voice-btn" data-voice-id="${voice.voiceId}">${i18n('Delete')}</button>
                        </div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        container.html(html);
    }

    // 更新Voice选择下拉框
    function updateVoiceSelect(voices) {
        const select = $('#tts-voice-select');
        const currentVoice = $('#tts-settings-form input[name="voice"]').val() || select.val();
        
        // 清空现有选项（保留第一个空选项）
        select.find('option:not(:first)').remove();
        
        // 如果是声音复刻模型，只添加复刻音色
        const model = $('#tts-model-select').val();
        if (model === 'qwen3-tts-vc-realtime-2025-11-27') {
            voices.forEach((voice) => {
                const option = $('<option>').val(voice.voiceId).text(`${voice.preferredName || voice.voiceId} (${voice.voiceId})`);
                if (voice.voiceId === currentVoice) {
                    option.prop('selected', true);
                }
                select.append(option);
            });
            select.show();
            $('#tts-voice-input').hide();
        } else {
            // 非声音复刻模型，显示默认音色选项
            select.append($('<option>').val('Cherry').text('Cherry (Default)'));
            if (currentVoice === 'Cherry' || !currentVoice) {
                select.val('Cherry');
            } else {
                // 如果当前选择的是自定义音色，显示输入框
                select.hide();
                $('#tts-voice-input').val(currentVoice).show();
            }
        }
    }

    // 选择音色
    $(document).on('click', '.select-voice-btn', function() {
        const voiceId = $(this).data('voice-id');
        $('#tts-voice-select').val(voiceId).trigger('change');
        Notification.success(i18n('Voice selected. Please save TTS configuration.'));
    });

    // 编辑音色名称
    $(document).on('click', '.edit-voice-btn', function() {
        const voiceId = $(this).data('voice-id');
        const currentName = $(this).data('preferred-name') || '';
        const newName = prompt(i18n('Enter new name for this voice:'), currentName);
        
        if (newName === null) return; // 用户取消
        
        if (!newName.trim()) {
            Notification.error(i18n('Voice name cannot be empty'));
            return;
        }

        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;
        
        const domainId = (window.UiContext?.domainId || 'system');

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/update-voice`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ voiceId, preferredName: newName }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Voice name updated successfully'));
                loadVoiceList();
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to update voice name: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    });

    // 删除音色
    $(document).on('click', '.delete-voice-btn', function() {
        const voiceId = $(this).data('voice-id');
        
        if (!confirm(i18n('Are you sure you want to delete this voice? This action cannot be undone.'))) {
            return;
        }

        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;
        
        const domainId = (window.UiContext?.domainId || 'system');

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/delete-voice`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ voiceId }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Voice deleted successfully'));
                loadVoiceList();
                // 如果删除的是当前选择的音色，清空选择
                if ($('#tts-voice-select').val() === voiceId) {
                    $('#tts-voice-select').val('');
                }
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to delete voice: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    });

    // Voice选择变化
    $('#tts-voice-select').on('change', function() {
        const selectedVoice = $(this).val();
        $('#tts-voice-input').val(selectedVoice || '');
    });
    
    // Voice输入框变化
    $('#tts-voice-input').on('input', function() {
        $('#tts-voice-select').val('');
    });

    // ASR configuration save
    $('#asr-settings-form').on('submit', function(e) {
        e.preventDefault();
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;
        
        const domainId = (window.UiContext?.domainId || 'system');
        const formData = {};
        $(this).serializeArray().forEach(item => {
            if (item.name === 'enableServerVad') {
                formData[item.name] = $(`input[name="${item.name}"]`).is(':checked');
            } else {
                formData[item.name] = item.value;
            }
        });

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/update-settings`,
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
        
        const domainId = (window.UiContext?.domainId || 'system');
        const formData = {};
        $(this).serializeArray().forEach(item => {
            formData[item.name] = item.value;
        });
        
        // 如果voice选择框有值，使用选择框的值；否则使用输入框的值
        const selectedVoice = $('#tts-voice-select').val();
        const inputVoice = $('#tts-voice-input').val();
        formData.voice = selectedVoice || inputVoice || '';

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/update-settings`,
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

    // Voice cloning form
    $('#voice-cloning-form').on('submit', function(e) {
        e.preventDefault();
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;
        
        const domainId = (window.UiContext?.domainId || 'system');
        const audioFile = $('#voice-audio-file')[0].files[0];
        
        if (!audioFile) {
            Notification.error(i18n('Please select an audio file'));
            return;
        }

        // Check if TTS model is set to qwen3-tts-vc-realtime-2025-11-27
        const currentModel = $('#tts-model-select').val();
        if (currentModel && currentModel !== 'qwen3-tts-vc-realtime-2025-11-27') {
            if (!confirm(i18n('The cloned voice can only be used with qwen3-tts-vc-realtime-2025-11-27 model. Do you want to switch to this model automatically after creating the voice?'))) {
                return;
            }
        }

        const formData = new FormData();
        formData.append('audioFile', audioFile);
        formData.append('region', $('#voice-region').val() || 'beijing');
        formData.append('preferredName', $('#voice-preferred-name').val() || 'custom');
        
        // Get API key from TTS settings form
        const apiKey = $('#tts-settings-form input[name="apiKey"]').val();
        if (!apiKey) {
            Notification.error(i18n('Please set API Key in TTS configuration first'));
            return;
        }
        formData.append('apiKey', apiKey);

        const $btn = $('#create-voice-btn');
        const originalText = $btn.text();
        $btn.prop('disabled', true).text(i18n('Creating...'));

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/create-voice`,
            method: 'POST',
            data: formData,
            processData: false,
            contentType: false,
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Voice created successfully. Voice ID: {0}').replace('{0}', response.voice));
                // Update voice input field
                $('#tts-settings-form input[name="voice"]').val(response.voice);
                
                // Auto-switch to qwen3-tts-vc-realtime-2025-11-27 model if not already selected
                if (currentModel !== 'qwen3-tts-vc-realtime-2025-11-27') {
                    $('#tts-model-select').val('qwen3-tts-vc-realtime-2025-11-27').trigger('change');
                    Notification.info(i18n('TTS model has been switched to qwen3-tts-vc-realtime-2025-11-27. Please save the TTS configuration.'));
                }
                
                // 刷新音色列表
                loadVoiceList();
                
                // 更新Voice选择
                updateVoiceSelect([response.voiceInfo]);
                
                // 自动选择新创建的音色
                $('#tts-voice-select').val(response.voice).trigger('change');
                
                // 清空表单
                $('#voice-cloning-form')[0].reset();
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to create voice: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        }).always(() => {
            $btn.prop('disabled', false).text(originalText);
        });
    });

    // Agent configuration save
    $('#agent-settings-form').on('submit', function(e) {
        e.preventDefault();
        const clientId = window.location.pathname.match(/\/client\/(\d+)/)?.[1];
        if (!clientId) return;
        
        const domainId = (window.UiContext?.domainId || 'system');
        const agentId = $('select[name="agentId"]').val();
        const agentData = agentId ? { agentId } : undefined;

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/update-settings`,
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
        
        const domainId = (window.UiContext?.domainId || 'system');

        $.ajax({
            url: `/d/${domainId}/client/${clientId}/update-settings`,
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


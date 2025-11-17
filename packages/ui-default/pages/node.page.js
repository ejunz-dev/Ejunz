import $ from 'jquery';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';

export default new AutoloadPage('node_domain,node_detail', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    const $container = $('.node-container');
    if (!$container.length) return;

    let sock = null;
    let mqttClient = null;
    const nodeId = $container.data('node-id');
    let nodeData = null;
    try {
        const nodeDataStr = $container.data('node-data');
        if (nodeDataStr) {
            nodeData = typeof nodeDataStr === 'string' ? JSON.parse(nodeDataStr) : nodeDataStr;
        }
    } catch (e) {
        console.error('Failed to parse node data:', e);
    }
    let nodeStatus = $container.data('node-status'); // 从模板获取节点状态（可能为 undefined）
    let hasConnected = false; // 标记是否曾经成功连接过

    async function connectMqtt() {
        if (!nodeData || !nodeData.connectionInfo || !nodeData.connectionInfo.mqtt) {
            console.log('MQTT connection info not available');
            return;
        }

        if (mqttClient) {
            mqttClient.end();
            mqttClient = null;
        }

        let mqtt = null;
        try {
            mqtt = await import(/* webpackIgnore: true */ 'mqtt');
            console.log('MQTT library loaded:', !!mqtt);
        } catch (e) {
            console.error('Failed to load MQTT library:', e);
            console.warn('MQTT library not available, falling back to WebSocket:', e);
            connectWebSocket();
            return;
        }

        const mqttModule = mqtt.default || mqtt;
        if (!mqttModule || !mqttModule.connect) {
            console.error('MQTT module does not have connect function:', mqttModule);
            connectWebSocket();
            return;
        }
        
        console.log('MQTT module ready, connecting...');

        const mqttInfo = nodeData.connectionInfo.mqtt;
        const mqttUrl = mqttInfo.wsUrl;
        const username = mqttInfo.username;
        const password = mqttInfo.password;

        console.log('Connecting to MQTT broker:', mqttUrl);
        
        const connectOptions = {
            username: username,
            password: password,
            clientId: `web_${nodeData.domainId}_${nodeData.nodeId}_${Date.now()}`,
            keepalive: 60,
            reconnectPeriod: 5000,
            connectTimeout: 10000,
            protocolVersion: 4, // MQTT 3.1.1 (Aedes supports 3.1.1, not 5.0)
            protocolId: 'MQTT',
        };
        
        console.log('MQTT connect options:', {
            url: mqttUrl,
            username: username,
            password: '***',
            clientId: connectOptions.clientId
        });
        
        mqttClient = mqttModule.connect(mqttUrl, connectOptions);

        mqttClient.on('connect', () => {
            console.log('MQTT connected successfully!', {
                clientId: mqttClient.options.clientId,
                url: mqttUrl
            });
            hasConnected = true;
            Notification.success('已连接到 MQTT');
            
            const stateTopic = `node/${nodeData.nodeId}/devices/+/state`;
            console.log('Subscribing to state updates:', stateTopic);
            mqttClient.subscribe(stateTopic, { qos: 1 }, (err, granted) => {
                if (err) {
                    console.error('Failed to subscribe to state updates:', err);
                    Notification.error('订阅状态更新失败');
                } else {
                    console.log('Successfully subscribed to state updates:', granted);
                }
            });
        });

        mqttClient.on('message', (topic, message) => {
            try {
                const data = JSON.parse(message.toString());
                console.log('MQTT message received:', topic, data);
                
                const topicParts = topic.split('/');
                if (topicParts.length >= 5 && topicParts[0] === 'node' && topicParts[2] === 'devices' && topicParts[4] === 'state') {
                    const deviceId = topicParts[3];
                    const state = data.state || data;
                    updateDeviceState(deviceId, state);
                }
            } catch (e) {
                console.error('Failed to parse MQTT message:', e);
            }
        });

        mqttClient.on('error', (error) => {
            console.error('MQTT connection error:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                errno: error.errno,
                stack: error.stack
            });
            Notification.error('MQTT 连接错误: ' + error.message);
            if (!hasConnected) {
                console.log('MQTT connection failed, falling back to WebSocket');
                setTimeout(() => {
                    if (!mqttClient || !mqttClient.connected) {
                        connectWebSocket();
                    }
                }, 2000);
            }
        });
        
        mqttClient.on('offline', () => {
            console.warn('MQTT client went offline');
        });
        
        mqttClient.on('reconnect', () => {
            console.log('MQTT client reconnecting...');
        });

        mqttClient.on('close', () => {
            console.log('MQTT disconnected');
            if (hasConnected) {
                Notification.warn('MQTT 连接已断开');
            }
            hasConnected = false;
        });
    }

    function connectWebSocket() {
        if (nodeStatus && nodeStatus !== 'active') {
            console.log('Node status is not active, skipping WebSocket connection');
            return;
        }

        if (sock) {
            sock.close();
        }
        
        const wsUrl = `${window.location.origin}/node/ws?nodeId=${nodeId}`;
        console.log('Connecting to WebSocket:', wsUrl);
        sock = new Sock(wsUrl, false, true);
        
        sock.onopen = () => {
            console.log('Node WebSocket connected');
            hasConnected = true;
            Notification.success('已连接到节点');
        };
        
        sock.onmessage = (msg, data) => {
            try {
                const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                handleWebSocketMessage(parsed);
            } catch (e) {
                console.error('Failed to parse WebSocket message:', e, 'data:', data);
            }
        };
        
        sock.onclose = (code, reason) => {
            console.log('Node WebSocket disconnected', 'code:', code, 'reason:', reason);
            if (hasConnected) {
                if (code >= 4000) {
                    Notification.error(`连接关闭: ${reason || '未知原因'} (code: ${code})`);
                } else {
                    Notification.warn('节点连接已断开');
                }
            }
            hasConnected = false;
        };
    }

    function handleWebSocketMessage(data) {
        switch (data.type) {
        case 'init':
            updateNodeInfo(data.node);
            updateDevices(data.devices);
            break;
        case 'device/update':
            updateDeviceState(data.deviceId, data.state);
            break;
        case 'devices':
            updateDevices(data.devices);
            break;
        case 'node/status':
            // Node 状态更新
            if (data.node) {
                updateNodeInfo(data.node);
                nodeStatus = data.node.status;
                // 如果节点状态变为 active，尝试连接
                if (data.node.status === 'active') {
                    if (!mqttClient && nodeData && nodeData.connectionInfo && nodeData.connectionInfo.mqtt) {
                        connectMqtt().catch(err => {
                            console.error('Failed to connect MQTT:', err);
                            if (!sock) {
                                connectWebSocket();
                            }
                        });
                    } else if (!sock) {
                        connectWebSocket();
                    }
                } else {
                    // 如果节点状态变为非 active，关闭连接
                    if (mqttClient) {
                        mqttClient.end();
                        mqttClient = null;
                    }
                    if (sock) {
                        sock.close();
                        sock = null;
                    }
                }
            } else {
                $('.node-status').text(data.status === 'active' ? '在线' : '离线');
                $('.node-status').removeClass('active inactive disconnected')
                    .addClass(data.status);
                nodeStatus = data.status;
                // 如果节点状态变为 active，尝试连接
                if (data.status === 'active') {
                    if (!mqttClient && nodeData && nodeData.connectionInfo && nodeData.connectionInfo.mqtt) {
                        connectMqtt().catch(err => {
                            console.error('Failed to connect MQTT:', err);
                            if (!sock) {
                                connectWebSocket();
                            }
                        });
                    } else if (!sock) {
                        connectWebSocket();
                    }
                } else {
                    // 如果节点状态变为非 active，关闭连接
                    if (mqttClient) {
                        mqttClient.end();
                        mqttClient = null;
                    }
                    if (sock) {
                        sock.close();
                        sock = null;
                    }
                }
            }
            break;
        case 'pong':
            // 心跳响应
            break;
        default:
            console.log('Unknown message type:', data.type);
        }
    }

    function updateNodeInfo(node) {
        if (node) {
            $('.node-status').text(node.status === 'active' ? '在线' : '离线');
            $('.node-status').removeClass('active inactive disconnected')
                .addClass(node.status);
        }
    }

    function updateDevices(devices) {
        const $deviceList = $('.device-list');
        $deviceList.empty();
        
        if (!devices || devices.length === 0) {
            $deviceList.append('<div class="no-devices">暂无设备</div>');
            return;
        }
        
        devices.forEach(device => {
            const $device = createDeviceCard(device);
            $deviceList.append($device);
        });
    }

    function createDeviceCard(device) {
        const $card = $(`
            <div class="device-card" data-device-id="${device.deviceId}">
                <div class="device-header">
                    <h3 class="device-name">${escapeHtml(device.name)}</h3>
                    <span class="device-type">${escapeHtml(device.type)}</span>
                </div>
                <div class="device-info">
                    ${device.manufacturer ? `<div>制造商: ${escapeHtml(device.manufacturer)}</div>` : ''}
                    ${device.model ? `<div>型号: ${escapeHtml(device.model)}</div>` : ''}
                    <div>最后更新: ${formatTime(device.lastSeen)}</div>
                </div>
                <div class="device-state">
                    ${renderDeviceState(device)}
                </div>
                <div class="device-controls">
                    ${renderDeviceControls(device)}
                </div>
            </div>
        `);
        
        // 绑定滑动开关事件
        $card.find('.switch-toggle').on('change', function() {
            const $toggle = $(this);
            const action = $toggle.data('action');
            const deviceId = $toggle.data('device-id');
            const isChecked = $toggle.is(':checked');
            console.log('Switch toggled:', { deviceId, action, isChecked });
            controlDevice(deviceId, action, isChecked);
        });
        
        return $card;
    }

    function renderDeviceState(device) {
        const state = device.state || {};
        let html = '<div class="state-items">';
        
        for (const [key, value] of Object.entries(state)) {
            html += `<div class="state-item">
                <span class="state-key">${escapeHtml(key)}:</span>
                <span class="state-value">${formatStateValue(value)}</span>
            </div>`;
        }
        
        html += '</div>';
        return html;
    }

    function renderDeviceControls(device) {
        const capabilities = device.capabilities || [];
        const state = device.state || {};
        let html = '<div class="control-buttons">';
        
        // 检查是否应该显示开关：有 capabilities 或状态中有开关相关字段
        const hasSwitchCapability = capabilities.some(cap => cap === 'on' || cap === 'off' || cap === 'switch');
        const hasSwitchState = state.on !== undefined || state.state !== undefined || state.power !== undefined;
        
        if (hasSwitchCapability || hasSwitchState) {
            // 检查设备状态：支持多种格式
            let isOn = false;
            
            if (state.on !== undefined) {
                isOn = state.on === true || state.on === 1 || state.on === '是' || state.on === 'ON' || state.on === 'on';
            } else if (state.state !== undefined) {
                const stateValue = state.state;
                if (typeof stateValue === 'string') {
                    isOn = /^(ON|on|ONLINE|online|true|1|是)$/i.test(stateValue);
                } else if (typeof stateValue === 'boolean') {
                    isOn = stateValue;
                } else if (typeof stateValue === 'number') {
                    isOn = stateValue > 0;
                }
            } else if (state.power !== undefined) {
                const powerValue = state.power;
                if (typeof powerValue === 'string') {
                    isOn = /^(ON|on|ONLINE|online|true|1|是)$/i.test(powerValue);
                } else if (typeof powerValue === 'boolean') {
                    isOn = powerValue;
                } else if (typeof powerValue === 'number') {
                    isOn = powerValue > 0;
                }
            }
            
            html += `<div class="switch-control">
                <span class="switch-text">${isOn ? '开启' : '关闭'}</span>
                <label class="switch-label">
                    <input type="checkbox" class="switch-toggle" 
                        data-device-id="${device.deviceId}"
                        data-action="on"
                        ${isOn ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                </label>
            </div>`;
        }
        
        if (capabilities.includes('brightness')) {
            html += `<div class="brightness-control">
                <label>亮度: <span class="brightness-value">${device.state?.brightness || 0}</span>%</label>
                <input type="range" class="brightness-slider" min="0" max="100" 
                    value="${device.state?.brightness || 0}" 
                    data-device-id="${device.deviceId}">
            </div>`;
        }
        
        html += '</div>';
        return html;
    }

    function controlDevice(deviceId, action, value) {
        const nodeId = $container.data('node-id');
        console.log('Sending control command:', { nodeId, deviceId, action, value });
        
        if (!nodeId) {
            console.error('Node ID not found');
            Notification.error('节点 ID 未找到');
            return;
        }
        
        if (!deviceId) {
            console.error('Device ID not found');
            Notification.error('设备 ID 未找到');
            return;
        }

        const isMqttConnected = mqttClient && (
            mqttClient.connected === true || 
            mqttClient.readyState === 1 || 
            (mqttClient.stream && mqttClient.stream.writable)
        );
        
        console.log('MQTT client status:', {
            hasClient: !!mqttClient,
            connected: mqttClient?.connected,
            readyState: mqttClient?.readyState,
            isMqttConnected: isMqttConnected,
            hasNodeData: !!nodeData,
            nodeId: nodeData?.nodeId
        });
        
        if (isMqttConnected && nodeData) {
            const topic = `node/${nodeData.nodeId}/devices/${deviceId}/set`;
            const command = { [action]: value };
            const payload = JSON.stringify(command);
            console.log('Publishing MQTT control command:', { topic, payload, command, action, value });
            mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
                if (err) {
                    console.error('Failed to publish control command:', err);
                    Notification.error('控制命令发送失败: ' + err.message);
                } else {
                    console.log('Control command published successfully to MQTT:', { topic, command });
                    Notification.success('控制命令已发送 (MQTT)');
                }
            });
        } else {
            console.log('MQTT not connected, using HTTP API fallback');
            const command = { [action]: value };
            console.log('Sending HTTP API control command:', { nodeId, deviceId, command, action, value });
            $.ajax({
                url: '/node/device/control',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({
                    nodeId,
                    deviceId,
                    command: command,
                }),
            }).then((response) => {
                console.log('Control command sent successfully via HTTP:', response);
                Notification.success('控制命令已发送 (HTTP)');
            }).catch((error) => {
                console.error('Control command failed:', error);
                Notification.error('控制失败: ' + (error.responseJSON?.error || error.message || '未知错误'));
            });
        }
    }

    function updateDeviceState(deviceId, state) {
        console.log('Updating device state via MQTT:', deviceId, state);
        const $device = $(`.device-card[data-device-id="${deviceId}"]`);
        if (!$device.length) {
            console.warn('Device card not found for deviceId:', deviceId, 'Available devices:', 
                $('.device-card').map((i, el) => $(el).data('device-id')).get());
            return;
        }
        
        const $stateContainer = $device.find('.device-state');
        if ($stateContainer.length) {
            $stateContainer.html(renderDeviceState({ state }));
        } else {
            console.warn('State container not found for device:', deviceId);
        }
        
        // Update switch state: supports multiple formats (on, state, power)
        const hasOnState = state.on !== undefined || state.state !== undefined || state.power !== undefined;
        if (hasOnState) {
            let isOn = false;
            if (state.on !== undefined) {
                isOn = state.on === true || state.on === 1 || state.on === '是' || state.on === 'ON' || state.on === 'on';
            } else if (state.state !== undefined) {
                const stateValue = state.state;
                if (typeof stateValue === 'string') {
                    isOn = /^(ON|on|ONLINE|online|true|1|是)$/i.test(stateValue);
                } else if (typeof stateValue === 'boolean') {
                    isOn = stateValue;
                } else if (typeof stateValue === 'number') {
                    isOn = stateValue > 0;
                }
            } else if (state.power !== undefined) {
                const powerValue = state.power;
                if (typeof powerValue === 'string') {
                    isOn = /^(ON|on|ONLINE|online|true|1|是)$/i.test(powerValue);
                } else if (typeof powerValue === 'boolean') {
                    isOn = powerValue;
                } else if (typeof powerValue === 'number') {
                    isOn = powerValue > 0;
                }
            }
            
            const $toggle = $device.find('.switch-toggle[data-action="on"]');
            const $switchText = $device.find('.switch-text');
            
            if ($toggle.length) {
                console.log('Updating switch state:', { deviceId, isOn, state });
                // Update without triggering change event to avoid loop
                $toggle.prop('checked', isOn);
                if ($switchText.length) {
                    $switchText.text(isOn ? '开启' : '关闭');
                }
            } else {
                // 如果开关不存在但应该有开关，重新渲染设备控制区域
                const $controls = $device.find('.device-controls');
                if ($controls.length && hasOnState) {
                    // 获取设备数据并重新渲染控制区域
                    const device = {
                        deviceId: deviceId,
                        capabilities: [],
                        state: state
                    };
                    $controls.html(renderDeviceControls(device));
                    // 重新绑定事件
                    $controls.find('.switch-toggle').on('change', function() {
                        const $toggle = $(this);
                        const action = $toggle.data('action');
                        const deviceId = $toggle.data('device-id');
                        const isChecked = $toggle.is(':checked');
                        controlDevice(deviceId, action, isChecked);
                    });
                }
            }
        }
        
        if (state.brightness !== undefined) {
            const $slider = $device.find('.brightness-slider');
            const $value = $device.find('.brightness-value');
            if ($slider.length) {
                $slider.val(state.brightness);
            }
            if ($value.length) {
                $value.text(state.brightness);
            }
        }
    }

    function formatStateValue(value) {
        if (typeof value === 'boolean') {
            return value ? '是' : '否';
        }
        if (typeof value === 'number') {
            return value.toString();
        }
        return escapeHtml(String(value));
    }

    function formatTime(date) {
        if (!date) return '未知';
        const d = new Date(date);
        return d.toLocaleString('zh-CN');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // 初始化
    if (nodeId) {
        console.log('Initializing node page:', {
            nodeId,
            hasNodeData: !!nodeData,
            hasConnectionInfo: !!(nodeData && nodeData.connectionInfo),
            hasMqttInfo: !!(nodeData && nodeData.connectionInfo && nodeData.connectionInfo.mqtt),
            nodeStatus
        });
        
        // 优先使用 MQTT 连接（如果连接信息可用）
        if (nodeData && nodeData.connectionInfo && nodeData.connectionInfo.mqtt) {
            console.log('Attempting MQTT connection...');
            connectMqtt().catch(err => {
                console.error('Failed to connect MQTT:', err);
                console.error('MQTT connection error details:', {
                    message: err.message,
                    stack: err.stack
                });
                // 降级到 WebSocket
                if (nodeStatus === 'active') {
                    console.log('Falling back to WebSocket');
                    connectWebSocket();
                }
            });
        } else {
            console.log('MQTT connection info not available, checking WebSocket fallback');
            if (nodeStatus === 'active') {
                // 降级到 WebSocket
                console.log('Using WebSocket connection');
                connectWebSocket();
            }
        }
        
        // 使用事件委托绑定滑动开关事件（因为设备是动态创建的）
        $(document).on('change', '.switch-toggle', function() {
            const $toggle = $(this);
            const action = $toggle.data('action');
            const deviceId = $toggle.data('device-id');
            const isChecked = $toggle.is(':checked');
            console.log('Switch toggled (delegated):', { deviceId, action, isChecked });
            if (deviceId && action) {
                controlDevice(deviceId, action, isChecked);
            } else {
                console.error('Missing deviceId or action:', { deviceId, action });
            }
        });
        
        // 绑定亮度滑块事件
        $(document).on('input', '.brightness-slider', function() {
            const deviceId = $(this).data('device-id');
            const value = parseInt($(this).val());
            controlDevice(deviceId, 'brightness', value);
        });
    }


    // 生成/删除连接 URL
    async function generateEndpoint(domainId, nodeId) {
        try {
            const response = await fetch(`/d/${domainId}/node/${nodeId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ operation: 'generateEndpoint' }),
            });
            
            const data = await response.json();
            if (data.connectionInfo) {
                location.reload();
            } else {
                Notification.error('生成连接 URL 失败');
            }
        } catch (error) {
            console.error('Error:', error);
            Notification.error('生成连接 URL 失败: ' + (error.message || '未知错误'));
        }
    }

    async function deleteEndpoint(domainId, nodeId) {
        if (!confirm('确定要删除连接 URL 吗？此操作无法撤销。')) {
            return;
        }
        
        try {
            const response = await fetch(`/d/${domainId}/node/${nodeId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ operation: 'deleteEndpoint' }),
            });
            
            const data = await response.json();
            if (data.success) {
                location.reload();
            } else {
                Notification.error('删除连接 URL 失败');
            }
        } catch (error) {
            console.error('Error:', error);
            Notification.error('删除连接 URL 失败: ' + (error.message || '未知错误'));
        }
    }

    // 绑定生成/删除连接 URL 按钮
    $(document).on('submit', '.endpoint-form', function(e) {
        e.preventDefault();
        const $form = $(this);
        const operation = $form.data('operation');
        const domainId = $form.data('domain-id');
        const nodeId = $form.data('node-id');
        
        if (operation === 'generateEndpoint') {
            generateEndpoint(domainId, nodeId);
        } else if (operation === 'deleteEndpoint') {
            deleteEndpoint(domainId, nodeId);
        }
    });

    // 删除节点
    $('.delete-node-btn').on('click', function() {
        if (!confirm('确定要删除这个节点吗？这将删除所有相关设备。')) return;
        
        const $btn = $(this);
        const nodeId = $btn.data('node-id');
        $btn.prop('disabled', true);
        
        $.ajax({
            url: '/node/delete',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ nodeId }),
        }).then(() => {
            Notification.success('节点已删除');
            window.location.href = '/node';
        }).catch((error) => {
            Notification.error('删除失败: ' + (error.responseJSON?.error || error.message));
            $btn.prop('disabled', false);
        });
    });
});


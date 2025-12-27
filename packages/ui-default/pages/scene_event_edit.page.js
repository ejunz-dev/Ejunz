import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';

const page = new NamedPage('scene_event_edit', () => {
    const domainId = (window.UiContext?.domainId || 'system');

    // 加载设备列表
    function loadSourceDevices(nodeId) {
        if (!nodeId) {
            $('#source-device-select').html('<option value="">请先选择节点</option>');
            return;
        }

        const nodeIdNum = parseInt(nodeId, 10);
        const currentDeviceId = window.currentEvent ? window.currentEvent.sourceDeviceId : null;
        const currentSourceNodeId = window.currentEvent ? parseInt(window.currentEvent.sourceNodeId, 10) : null;

        if (window.nodeDevicesMap && window.nodeDevicesMap[nodeIdNum]) {
            const devices = window.nodeDevicesMap[nodeIdNum];
            let html = '<option value="">请选择设备</option>';
            devices.forEach(device => {
                const selected = (currentDeviceId === device.deviceId && currentSourceNodeId === nodeIdNum) ? 'selected' : '';
                html += `<option value="${device.deviceId}" ${selected}>${device.name} (${device.deviceId})</option>`;
            });
            $('#source-device-select').html(html);
        } else {
            // 如果 nodeDevicesMap 中没有，通过 API 加载
            request.get(`/d/${domainId}/scene/node/${nodeIdNum}/devices`).then(response => {
                const devices = response.devices || [];
                let html = '<option value="">请选择设备</option>';
                devices.forEach(device => {
                    const selected = (currentDeviceId === device.deviceId && currentSourceNodeId === nodeIdNum) ? 'selected' : '';
                    html += `<option value="${device.deviceId}" ${selected}>${device.name} (${device.deviceId})</option>`;
                });
                $('#source-device-select').html(html);
            }).catch(error => {
                Notification.error('加载设备列表失败: ' + (error.message || '未知错误'));
            });
        }
    }

    function loadTargetDevices(nodeId) {
        if (!nodeId) {
            $('#target-device-select').html('<option value="">请先选择节点</option>');
            return;
        }

        const nodeIdNum = parseInt(nodeId, 10);
        const currentDeviceId = window.currentEvent ? window.currentEvent.targetDeviceId : null;
        const currentTargetNodeId = window.currentEvent ? parseInt(window.currentEvent.targetNodeId, 10) : null;

        if (window.nodeDevicesMap && window.nodeDevicesMap[nodeIdNum]) {
            const devices = window.nodeDevicesMap[nodeIdNum];
            let html = '<option value="">请选择设备</option>';
            devices.forEach(device => {
                const selected = (currentDeviceId === device.deviceId && currentTargetNodeId === nodeIdNum) ? 'selected' : '';
                html += `<option value="${device.deviceId}" ${selected}>${device.name} (${device.deviceId})</option>`;
            });
            $('#target-device-select').html(html);
        } else {
            // 如果 nodeDevicesMap 中没有，通过 API 加载
            request.get(`/d/${domainId}/scene/node/${nodeIdNum}/devices`).then(response => {
                const devices = response.devices || [];
                let html = '<option value="">请选择设备</option>';
                devices.forEach(device => {
                    const selected = (currentDeviceId === device.deviceId && currentTargetNodeId === nodeIdNum) ? 'selected' : '';
                    html += `<option value="${device.deviceId}" ${selected}>${device.name} (${device.deviceId})</option>`;
                });
                $('#target-device-select').html(html);
            }).catch(error => {
                Notification.error('加载设备列表失败: ' + (error.message || '未知错误'));
            });
        }
    }

    // 监听源节点变化
    $('#source-node-select').on('change', function() {
        const nodeId = parseInt($(this).val(), 10);
        loadSourceDevices(nodeId);
    });

    // 监听目标节点变化
    $('#target-node-select').on('change', function() {
        const nodeId = parseInt($(this).val(), 10);
        loadTargetDevices(nodeId);
    });

    // 页面加载时，如果有当前事件，加载对应的设备列表
    if (window.currentEvent) {
        // 确保节点 ID 是数字类型
        const sourceNodeId = parseInt(window.currentEvent.sourceNodeId, 10);
        const targetNodeId = parseInt(window.currentEvent.targetNodeId, 10);
        
        if (sourceNodeId && !isNaN(sourceNodeId)) {
            // 设置源节点选择框的值
            $('#source-node-select').val(sourceNodeId);
            // 延迟加载设备列表，确保 DOM 已准备好
            setTimeout(() => {
                loadSourceDevices(sourceNodeId);
            }, 100);
        }
        
        if (targetNodeId && !isNaN(targetNodeId)) {
            // 设置目标节点选择框的值
            $('#target-node-select').val(targetNodeId);
            // 延迟加载设备列表，确保 DOM 已准备好
            setTimeout(() => {
                loadTargetDevices(targetNodeId);
            }, 150);
        }
    }
});

export default page;


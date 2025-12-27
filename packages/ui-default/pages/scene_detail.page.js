import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';

const page = new NamedPage('scene_detail', () => {
    const domainId = (window.UiContext?.domainId || 'system');
    const sceneId = parseInt(window.location.pathname.match(/\/scene\/(\d+)/)?.[1] || '0', 10);

    // 编辑模式切换（完全按照 agent 页面的方式实现）
    const $body = $('body');
    $body.addClass('display-mode');
    
    // 绑定编辑模式切换事件（完全按照 agent 页面的方式）
    $(document).on('click', '[name="leave-edit-mode"]', () => {
        $body.removeClass('edit-mode').addClass('display-mode');
    });
    $(document).on('click', '[name="enter-edit-mode"]', () => {
        $body.removeClass('display-mode').addClass('edit-mode');
    });

    // 删除单个事件
    $(document).on('click', '.delete-event-btn', async function(e) {
        e.preventDefault();
        e.stopPropagation();
        const eid = parseInt($(this).data('eid'), 10);
        
        if (!confirm(`确定要删除事件 ${eid} 吗？删除后无法恢复。`)) {
            return;
        }

        try {
            await request.post(`/d/${domainId}/scene/${sceneId}/event/${eid}/delete`);
            Notification.success('事件已删除');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (error) {
            Notification.error('删除失败: ' + (error.message || '未知错误'));
        }
    });

    // 获取选中的事件 ID
    function getSelectedEventIds() {
        const eids = [];
        $('tbody [data-checkbox-group="event"]:checked').each(function() {
            const eid = parseInt($(this).closest('tr').data('eid'), 10);
            if (eid) eids.push(eid);
        });
        return eids;
    }

    // 批量操作处理
    async function handleBulkOperation(operation) {
        const eids = getSelectedEventIds();
        if (eids.length === 0) {
            Notification.error('请至少选择一个事件');
            return;
        }

        let confirmMsg = '';
        if (operation === 'delete') {
            confirmMsg = `确定要删除选中的 ${eids.length} 个事件吗？删除后无法恢复。`;
        } else if (operation === 'enable') {
            confirmMsg = `确定要启用选中的 ${eids.length} 个事件吗？`;
        } else if (operation === 'disable') {
            confirmMsg = `确定要禁用选中的 ${eids.length} 个事件吗？`;
        }

        if (confirmMsg && !confirm(confirmMsg)) {
            return;
        }

        try {
            await request.post(`/d/${domainId}/scene/${sceneId}/events/bulk`, {
                operation,
                eids,
            });
            Notification.success(`已成功${operation === 'delete' ? '删除' : operation === 'enable' ? '启用' : '禁用'} ${eids.length} 个事件`);
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (error) {
            Notification.error('操作失败: ' + (error.message || '未知错误'));
        }
    }

    // 绑定批量操作按钮
    $(document).on('click', '[name="enable_selected_events"]', () => handleBulkOperation('enable'));
    $(document).on('click', '[name="disable_selected_events"]', () => handleBulkOperation('disable'));
    $(document).on('click', '[name="delete_selected_events"]', () => handleBulkOperation('delete'));

    // 启用/禁用场景
    $(document).on('click', '.scene-toggle-btn', async function() {
        const $btn = $(this);
        const sid = $btn.data('sid');
        const currentEnabled = $btn.data('enabled') === 'true';
        const newEnabled = !currentEnabled;

        try {
            await request.post(`/d/${domainId}/scene/${sid}/toggle`, {
                enabled: newEnabled,
            });
            Notification.success(newEnabled ? '场景已启用' : '场景已禁用');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (error) {
            Notification.error('操作失败: ' + (error.message || '未知错误'));
        }
    });
});

export default page;


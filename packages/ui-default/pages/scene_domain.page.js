import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';

const page = new NamedPage('scene_domain', () => {
    const domainId = (window.UiContext?.domainId || 'system');

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

    // 删除场景
    $(document).on('click', '.scene-delete-btn', async function() {
        const $btn = $(this);
        const sid = $btn.data('sid');
        
        if (!confirm(`确定要删除场景 ${sid} 吗？删除后无法恢复。`)) {
            return;
        }

        try {
            await request.post(`/d/${domainId}/scene/${sid}/delete`);
            Notification.success('场景已删除');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (error) {
            Notification.error('删除失败: ' + (error.message || '未知错误'));
        }
    });
});

export default page;


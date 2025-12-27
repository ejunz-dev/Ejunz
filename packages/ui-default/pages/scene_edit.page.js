import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { request } from 'vj/utils';

const page = new NamedPage('scene_edit', () => {
    const domainId = (window.UiContext?.domainId || 'system');

    // 删除场景
    window.deleteScene = async function(sid) {
        if (!confirm(`确定要删除场景 ${sid} 吗？删除后无法恢复。`)) {
            return;
        }

        try {
            await request.post(`/d/${domainId}/scene/${sid}/delete`);
            Notification.success('场景已删除');
            setTimeout(() => {
                window.location.href = `/d/${domainId}/scene`;
            }, 1000);
        } catch (error) {
            Notification.error('删除失败: ' + (error.message || '未知错误'));
        }
    };
});

export default page;


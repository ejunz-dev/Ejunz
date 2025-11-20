import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';

const page = new NamedPage('workflow_domain', async () => {
  // 工作流列表页面逻辑
  $('.workflow-item').on('click', '.workflow-actions .button', function(e) {
    e.stopPropagation();
  });
});

export default page;


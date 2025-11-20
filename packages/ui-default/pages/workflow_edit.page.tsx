import { NamedPage } from 'vj/misc/Page';

// 这个文件现在只用于基本信息编辑，节点编辑器已移到 workflow_editFlow.page.tsx
// 基本信息编辑使用纯 HTML 表单，不需要 React 组件
const page = new NamedPage('workflow_edit', async () => {
  // 基本信息编辑页面不需要额外的 JavaScript 逻辑
});

export default page;

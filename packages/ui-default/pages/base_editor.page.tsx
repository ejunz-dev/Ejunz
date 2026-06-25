import $ from 'jquery';
import React from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, i18n, domainScopedPath, domainApiPath } from 'vj/utils';
import { BaseEditorMode } from 'vj/components/base/BaseEditor';
import type { BaseDoc } from 'vj/components/base/types';

const getBaseUrl = (path: string, docId: string): string => {
  return domainScopedPath(`/base/${docId}${path}`);
};

const page = new NamedPage(['base_editor', 'base_editor_branch', 'develop_editor', 'plugin_editor'], async (pageName) => {
  try {
    const $container = $('#base-editor-mode');
    if (!$container.length) {
      return;
    }

    const domainId = (window as any).UiContext?.domainId || 'system';
    const docId = $container.data('doc-id') || $container.attr('data-doc-id') || '';


    let initialData: BaseDoc;
    try {

      const editorApiBasePath = (window as any).UiContext?.editorApiBasePath || 'base';
      const apiPath = domainApiPath(`/${editorApiBasePath}/data`, domainId);
      const initQs: Record<string, string> = {};
      if (docId) initQs.docId = docId;
      const initBranch = (window as any).UiContext?.currentBranch;
      if (initBranch) initQs.branch = initBranch;
      const response = await request.get(apiPath, initQs);
      initialData = response;

      if (!initialData.docId) {
        initialData.docId = docId || '';
      }
    } catch (error: any) {
      Notification.error('加载知识库失败: ' + (error.message || '未知错误'));
      return;
    }

    ReactDOM.render(
      <BaseEditorMode docId={initialData.docId || ''} initialData={initialData} basePath={(window as any).UiContext?.editorApiBasePath || 'base'} />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize editor mode:', error);
    Notification.error('初始化编辑器模式失败: ' + (error.message || '未知错误'));
  }
});

export default page;

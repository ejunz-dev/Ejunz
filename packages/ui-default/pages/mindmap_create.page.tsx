import $ from 'jquery';
import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

function MindMapCreate() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [rpid, setRpid] = useState<number | undefined>(undefined);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!title.trim()) {
      Notification.error('请输入标题');
      return;
    }

    setSubmitting(true);
    try {
      const params: any = {
        title: title.trim(),
        content: content.trim(),
      };
      if (rpid) params.rpid = rpid;
      if (branch) params.branch = branch;

      const response = await request.post('/mindmap/create', params);
      
      Notification.success('思维导图创建成功');
      const domainId = (window as any).UiContext?.domainId || '';
      window.location.href = `/d/${domainId}/mindmap/${response.docId}`;
    } catch (error: any) {
      Notification.error('创建失败: ' + (error.message || '未知错误'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '20px' }}>创建思维导图</h1>
      
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
            标题 <span style={{ color: '#f44336' }}>*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="textbox"
            style={{ width: '100%', padding: '8px' }}
            placeholder="请输入思维导图标题"
            required
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
            描述
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="textbox"
            style={{ width: '100%', padding: '8px', minHeight: '100px' }}
            placeholder="请输入思维导图描述（可选）"
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
            关联仓库ID（可选）
          </label>
          <input
            type="number"
            value={rpid || ''}
            onChange={(e) => setRpid(e.target.value ? parseInt(e.target.value, 10) : undefined)}
            className="textbox"
            style={{ width: '100%', padding: '8px' }}
            placeholder="输入仓库ID（可选）"
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
            分支（可选）
          </label>
          <input
            type="text"
            value={branch || ''}
            onChange={(e) => setBranch(e.target.value || undefined)}
            className="textbox"
            style={{ width: '100%', padding: '8px' }}
            placeholder="输入分支名称（可选）"
          />
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '10px 20px',
              background: '#2196f3',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? '创建中...' : '创建'}
          </button>
          <a
            href="/mindmap"
            style={{
              padding: '10px 20px',
              background: '#757575',
              color: '#fff',
              textDecoration: 'none',
              borderRadius: '4px',
              display: 'inline-block',
            }}
          >
            取消
          </a>
        </div>
      </form>
    </div>
  );
}

const page = new NamedPage('mindmap_create', async () => {
  try {
    const $container = $('#mindmap-create');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <MindMapCreate />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize mindmap create:', error);
    Notification.error('初始化创建页面失败: ' + (error.message || '未知错误'));
  }
});

export default page;


import $ from 'jquery';
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

interface MindMapItem {
  docId: string;
  mmid: number;
  title: string;
  content: string;
  owner: number;
  createdAt: string;
  updateAt: string;
  views: number;
  rpid?: number;
  branch?: string;
}

function MindMapList() {
  const [mindMaps, setMindMaps] = useState<MindMapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [rpid, setRpid] = useState<number | undefined>(undefined);
  const [branch, setBranch] = useState<string | undefined>(undefined);

  useEffect(() => {
    loadMindMaps();
  }, [rpid, branch]);

  const loadMindMaps = async () => {
    try {
      setLoading(true);
      const domainId = (window as any).UiContext?.domainId || 'system';
      const params: any = {};
      if (rpid) params.rpid = rpid;
      if (branch) params.branch = branch;

      const response = await request.get(`/d/${domainId}/mindmap`, { params });
      setMindMaps(response.mindMaps || []);
    } catch (error: any) {
      Notification.error('加载思维导图列表失败: ' + (error.message || '未知错误'));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (docId: string, title: string) => {
    if (!confirm(`确定要删除思维导图"${title}"吗？`)) {
      return;
    }

    try {
      // 删除操作
      const domainId = (window as any).UiContext?.domainId || 'system';
      await request.post(`/d/${domainId}/mindmap/${docId}/edit`, {
        operation: 'delete',
      });
      Notification.success('思维导图已删除');
      loadMindMaps();
    } catch (error: any) {
      Notification.error('删除失败: ' + (error.message || '未知错误'));
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ margin: 0 }}>思维导图列表</h1>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <div>加载中...</div>
        </div>
      ) : mindMaps.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
          <p>暂无思维导图</p>
          <a
            href={(() => {
              const domainId = (window as any).UiContext?.domainId || 'system';
              return `/d/${domainId}/mindmap/create`;
            })()}
            style={{
              padding: '8px 16px',
              background: '#2196f3',
              color: '#fff',
              textDecoration: 'none',
              borderRadius: '4px',
              display: 'inline-block',
              marginTop: '10px',
            }}
          >
            创建第一个思维导图
          </a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {mindMaps.map((mindMap) => (
            <div
              key={mindMap.docId}
              style={{
                border: '1px solid #ddd',
                borderRadius: '8px',
                padding: '20px',
                background: '#fff',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                transition: 'transform 0.2s, box-shadow 0.2s',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,0,0,0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
              }}
              onClick={() => {
                const domainId = (window as any).UiContext?.domainId || '';
                window.location.href = `/d/${domainId}/mindmap/${mindMap.docId}`;
              }}
            >
              <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', color: '#333' }}>
                {mindMap.title}
              </h3>
              {mindMap.content && (
                <p style={{ margin: '0 0 15px 0', color: '#666', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {mindMap.content}
                </p>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#999', marginTop: '15px' }}>
                <span>访问量: {mindMap.views}</span>
                <span>{new Date(mindMap.updateAt).toLocaleDateString()}</span>
              </div>
              <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
                <a
                  href={(() => {
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    return `/d/${domainId}/mindmap/${mindMap.docId}`;
                  })()}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    padding: '4px 12px',
                    background: '#2196f3',
                    color: '#fff',
                    textDecoration: 'none',
                    borderRadius: '4px',
                    fontSize: '12px',
                  }}
                >
                  查看
                </a>
                <a
                  href={(() => {
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    return `/d/${domainId}/mindmap/${mindMap.docId}/edit`;
                  })()}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    padding: '4px 12px',
                    background: '#4caf50',
                    color: '#fff',
                    textDecoration: 'none',
                    borderRadius: '4px',
                    fontSize: '12px',
                  }}
                >
                  编辑
                </a>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(mindMap.docId, mindMap.title);
                  }}
                  style={{
                    padding: '4px 12px',
                    background: '#f44336',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const page = new NamedPage('mindmap_list', async () => {
  try {
    const $container = $('#mindmap-list');
    if (!$container.length) {
      return;
    }

    const rpid = $container.data('rpid');
    const branch = $container.data('branch');

    ReactDOM.render(
      <MindMapList />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize mindmap list:', error);
    Notification.error('初始化思维导图列表失败: ' + (error.message || '未知错误'));
  }
});

export default page;


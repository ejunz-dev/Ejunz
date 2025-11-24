import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

const page = new NamedPage('mindmap_card_list', () => {
  // 从 UiContext 获取数据
  const cards = window.UiContext?.cards || [];
  const baseUrl = window.UiContext?.baseUrl || '';
  const nodeId = window.UiContext?.nodeId || '';
  const mindMap = window.UiContext?.mindMap || {};
  
  if (!baseUrl) {
    console.warn('Card list data not found');
    return;
  }
  
  let isEditMode = false;
  let draggedElement = null;
  let draggedIndex = null;
  let dragOverIndex = null;
  
  // 定义 loadCard 函数
  function loadCard(cardId) {
    // 找到对应的卡片
    const card = cards.find(c => {
      const cardDocId = c.docId ? (c.docId.toString ? c.docId.toString() : String(c.docId)) : null;
      const targetCardId = String(cardId);
      return cardDocId === targetCardId;
    });
    if (!card) return;
    
    // 更新 URL（无跳转）
    const newUrl = baseUrl + '?cardId=' + encodeURIComponent(cardId);
    window.history.pushState({ cardId: cardId }, '', newUrl);
    
    // 更新标题
    const titleElement = document.getElementById('card-title');
    if (titleElement) {
      titleElement.textContent = card.title || '未命名卡片';
    }
    
    // 更新内容（需要从后端获取渲染后的 Markdown）
    const contentDiv = document.getElementById('card-content');
    if (!contentDiv) return;
    
    if (card.content) {
      // 显示加载状态
      contentDiv.innerHTML = '<p style="color: #999; text-align: center;">加载中...</p>';
      
      fetch('/markdown', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: card.content || '',
          inline: false,
        }),
      })
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to render markdown');
        }
        return response.text();
      })
      .then(html => {
        contentDiv.innerHTML = html;
      })
      .catch(error => {
        console.error('Failed to render markdown:', error);
        contentDiv.innerHTML = '<p style="color: #f44336;">加载内容失败</p>';
      });
    } else {
      contentDiv.innerHTML = '<p style="color: #888;">暂无内容</p>';
    }
    
    // 更新侧边栏选中状态
    document.querySelectorAll('.card-item').forEach(item => {
      const itemCardId = item.getAttribute('data-card-id');
      if (itemCardId === String(cardId)) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }
  
  // 进入编辑模式
  function enterEditMode() {
    isEditMode = true;
    const container = document.getElementById('card-list-container');
    if (container) {
      container.classList.add('edit-mode');
    }
    
    // 显示/隐藏按钮
    const editBtn = document.getElementById('edit-mode-btn');
    const saveBtn = document.getElementById('save-order-btn');
    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (editBtn) editBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'inline-block';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    
    // 显示拖动手柄（通过 CSS 类控制）
    
    // 启用拖动
    setupDragAndDrop();
  }
  
  // 退出编辑模式
  function exitEditMode() {
    isEditMode = false;
    const container = document.getElementById('card-list-container');
    if (container) {
      container.classList.remove('edit-mode');
    }
    
    // 显示/隐藏按钮
    const editBtn = document.getElementById('edit-mode-btn');
    const saveBtn = document.getElementById('save-order-btn');
    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (editBtn) editBtn.style.display = 'inline-block';
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    
    // 隐藏拖动手柄（通过 CSS 类控制）
    
    // 恢复原始顺序
    restoreOriginalOrder();
  }
  
  // 保存排序
  async function saveOrder() {
    const cardItems = Array.from(document.querySelectorAll('.card-item'));
    const updates = [];
    
    for (let i = 0; i < cardItems.length; i++) {
      const item = cardItems[i];
      const cardId = item.getAttribute('data-card-id');
      if (cardId) {
        updates.push({
          cardId,
          order: i + 1
        });
      }
    }
    
    try {
      // 批量更新卡片顺序
      for (const update of updates) {
        // 使用正确的路由格式，确保 operation 在请求体中
        const url = `/mindmap/card/${update.cardId}`;
        await request.post(url, {
          nodeId: nodeId,
          operation: 'update',
          order: update.order
        });
      }
      
      Notification.success('排序已保存');
      exitEditMode();
      
      // 重新加载页面以获取最新数据
      window.location.reload();
    } catch (error) {
      console.error('Failed to save order:', error);
      Notification.error('保存排序失败: ' + (error.message || '未知错误'));
    }
  }
  
  // 恢复原始顺序
  function restoreOriginalOrder() {
    const container = document.getElementById('card-list-container');
    if (!container) return;
    
    // 按照 data-order 属性排序
    const items = Array.from(container.querySelectorAll('.card-item'));
    items.sort((a, b) => {
      const orderA = parseInt(a.getAttribute('data-order') || '0');
      const orderB = parseInt(b.getAttribute('data-order') || '0');
      return orderA - orderB;
    });
    
    items.forEach(item => container.appendChild(item));
  }
  
  // 设置拖动功能
  function setupDragAndDrop() {
    const cardItems = document.querySelectorAll('.card-item');
    
    cardItems.forEach((item) => {
      // 设置可拖动
      item.draggable = true;
      
      const dragHandle = item.querySelector('.drag-handle');
      if (dragHandle) {
        dragHandle.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
      }
      
      // 移除旧的事件监听器（通过克隆节点）
      const newItem = item.cloneNode(true);
      item.parentNode.replaceChild(newItem, item);
      
      newItem.addEventListener('dragstart', (e) => {
        draggedElement = newItem;
        newItem.classList.add('dragging');
        newItem.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', '');
      });
      
      newItem.addEventListener('dragend', (e) => {
        newItem.classList.remove('dragging');
        newItem.style.opacity = '1';
        draggedElement = null;
        // 清除所有拖拽样式
        document.querySelectorAll('.card-item').forEach(el => {
          el.style.borderTop = '';
          el.style.borderBottom = '';
        });
      });
      
      newItem.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        
        if (draggedElement && draggedElement !== newItem) {
          const rect = newItem.getBoundingClientRect();
          const mouseY = e.clientY;
          const itemMiddle = rect.top + rect.height / 2;
          
          // 清除之前的样式
          document.querySelectorAll('.card-item').forEach(el => {
            if (el !== newItem) {
              el.style.borderTop = '';
              el.style.borderBottom = '';
            }
          });
          
          if (mouseY < itemMiddle) {
            // 拖到上方
            newItem.style.borderTop = '3px solid #2196f3';
            newItem.style.borderBottom = '';
          } else {
            // 拖到下方
            newItem.style.borderBottom = '3px solid #2196f3';
            newItem.style.borderTop = '';
          }
        }
      });
      
      newItem.addEventListener('dragleave', (e) => {
        newItem.style.borderTop = '';
        newItem.style.borderBottom = '';
      });
      
      newItem.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (draggedElement && draggedElement !== newItem) {
          const container = document.getElementById('card-list-container');
          if (!container) return;
          
          const items = Array.from(container.querySelectorAll('.card-item'));
          const draggedIdx = items.indexOf(draggedElement);
          const targetIdx = items.indexOf(newItem);
          
          if (draggedIdx !== -1 && targetIdx !== -1 && draggedIdx !== targetIdx) {
            const rect = newItem.getBoundingClientRect();
            const mouseY = e.clientY;
            const itemMiddle = rect.top + rect.height / 2;
            
            if (mouseY < itemMiddle) {
              // 插入到目标元素之前
              container.insertBefore(draggedElement, newItem);
            } else {
              // 插入到目标元素之后
              if (newItem.nextSibling) {
                container.insertBefore(draggedElement, newItem.nextSibling);
              } else {
                container.appendChild(draggedElement);
              }
            }
            
            // 重新设置拖动功能（因为 DOM 顺序改变了）
            setupDragAndDrop();
          }
        }
        
        // 清除样式
        document.querySelectorAll('.card-item').forEach(el => {
          el.style.borderTop = '';
          el.style.borderBottom = '';
        });
      });
      
      // 在编辑模式下禁用点击事件
      newItem.addEventListener('click', function(e) {
        if (isEditMode) {
          e.preventDefault();
          e.stopPropagation();
        } else {
          const cardId = this.getAttribute('data-card-id');
          if (cardId) {
            loadCard(cardId);
          }
        }
      });
    });
  }
  
  // 页面加载时，初始化事件监听器和加载卡片
  function init() {
    // 编辑模式按钮
    const editBtn = document.getElementById('edit-mode-btn');
    if (editBtn) {
      editBtn.addEventListener('click', enterEditMode);
    }
    
    // 保存按钮
    const saveBtn = document.getElementById('save-order-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', saveOrder);
    }
    
    // 取消按钮
    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', exitEditMode);
    }
    
    // 为所有卡片项添加点击事件
    document.querySelectorAll('.card-item').forEach(item => {
      item.addEventListener('click', function(e) {
        if (isEditMode) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const cardId = this.getAttribute('data-card-id');
        if (cardId) {
          loadCard(cardId);
        }
      });
      
      // 悬停效果由 CSS 处理
    });
    
    // 检查 URL 参数并加载对应卡片
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    if (cardId && cards.length > 0) {
      // 如果 URL 中有 cardId，加载对应的卡片
      loadCard(cardId);
    } else if (cards.length > 0) {
      // 如果没有 cardId，加载第一个卡片并更新 URL
      const firstCardId = cards[0].docId ? (cards[0].docId.toString ? cards[0].docId.toString() : String(cards[0].docId)) : null;
      if (firstCardId) {
        loadCard(firstCardId);
      }
    }
  }
  
  // 处理浏览器前进/后退
  window.addEventListener('popstate', function(event) {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    if (cardId) {
      loadCard(cardId);
    } else if (cards.length > 0) {
      // 如果没有 cardId，加载第一个卡片
      const firstCardId = cards[0].docId ? (cards[0].docId.toString ? cards[0].docId.toString() : String(cards[0].docId)) : null;
      if (firstCardId) {
        loadCard(firstCardId);
      }
    }
  });
  
  // 初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
});

export default page;


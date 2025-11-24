import { NamedPage } from 'vj/misc/Page';

const page = new NamedPage('mindmap_card_list', () => {
  // 从 UiContext 获取数据
  const cards = window.UiContext?.cards || [];
  const baseUrl = window.UiContext?.baseUrl || '';
  
  if (!cards.length || !baseUrl) {
    console.warn('Card list data not found');
    return;
  }
  
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
      const cardTitleDiv = item.querySelector('div');
      if (itemCardId === String(cardId)) {
        item.classList.add('selected');
        item.style.background = '#e3f2fd';
        item.style.border = '2px solid #2196f3';
        if (cardTitleDiv) {
          cardTitleDiv.style.fontWeight = '600';
        }
      } else {
        item.classList.remove('selected');
        item.style.background = '#fff';
        item.style.border = '1px solid #e0e0e0';
        if (cardTitleDiv) {
          cardTitleDiv.style.fontWeight = '400';
        }
      }
    });
  }
  
  // 页面加载时，初始化事件监听器和加载卡片
  function init() {
    // 为所有卡片项添加点击事件
    document.querySelectorAll('.card-item').forEach(item => {
      item.addEventListener('click', function() {
        const cardId = this.getAttribute('data-card-id');
        if (cardId) {
          loadCard(cardId);
        }
      });
      
      // 添加悬停效果
      item.addEventListener('mouseenter', function() {
        if (!this.classList.contains('selected')) {
          this.style.background = '#f5f5f5';
        }
      });
      
      item.addEventListener('mouseleave', function() {
        if (!this.classList.contains('selected')) {
          this.style.background = '#fff';
        }
      });
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


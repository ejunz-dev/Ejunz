import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

const page = new NamedPage('base_card_list', () => {
  // 从 UiContext 获取数据
  let cards = window.UiContext?.cards || [];
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
  let allCards = [...cards]; // 存储当前节点的所有卡片
  let cardContentCache = {}; // 缓存已渲染的卡片内容
  let imageCache = null; // Cache API 实例
  
  // 初始化图片缓存
  async function initImageCache() {
    if ('caches' in window && !imageCache) {
      try {
        imageCache = await caches.open('base-card-images-v1');
      } catch (error) {
        console.error('Failed to open cache:', error);
      }
    }
  }
  
  // 从缓存或网络获取图片
  async function getCachedImage(url) {
    if (!imageCache) {
      await initImageCache();
    }
    
    if (!imageCache) {
      // 如果 Cache API 不可用，直接返回原 URL
      return url;
    }
    
    try {
      // 先检查缓存
      const cachedResponse = await imageCache.match(url);
      if (cachedResponse) {
        // 从缓存创建 blob URL
        const blob = await cachedResponse.blob();
        return URL.createObjectURL(blob);
      }
      
      // 缓存中没有，从网络获取
      const response = await fetch(url);
      if (response.ok) {
        // 克隆响应（因为响应只能读取一次）
        const responseClone = response.clone();
        // 存储到缓存
        await imageCache.put(url, responseClone);
        // 返回 blob URL
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      }
    } catch (error) {
      console.error(`Failed to cache image ${url}:`, error);
    }
    
    // 如果出错，返回原 URL
    return url;
  }
  
  // 预加载并缓存图片
  async function preloadAndCacheImages(html) {
    if (!html) return html;
    
    // 使用正则表达式提取所有图片 URL
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const imageUrls = [];
    let match;
    
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
      if (url && !url.startsWith('blob:') && !url.startsWith('data:')) {
        imageUrls.push(url);
      }
    }
    
    if (imageUrls.length === 0) return html;
    
    // 初始化缓存
    await initImageCache();
    
    // 替换所有图片 URL 为缓存版本
    const urlMap = new Map();
    const imagePromises = imageUrls.map(async (originalUrl) => {
      try {
        const cachedUrl = await getCachedImage(originalUrl);
        if (cachedUrl !== originalUrl) {
          urlMap.set(originalUrl, cachedUrl);
        }
      } catch (error) {
        console.error(`Failed to cache image ${originalUrl}:`, error);
      }
    });
    
    await Promise.all(imagePromises);
    
    // 替换 HTML 中的图片 URL
    let updatedHtml = html;
    urlMap.forEach((cachedUrl, originalUrl) => {
      // 转义特殊字符用于正则表达式
      const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      updatedHtml = updatedHtml.replace(new RegExp(escapedUrl, 'g'), cachedUrl);
    });
    
    return updatedHtml;
  }
  
  // 显示进度条
  function showProgress(total) {
    const container = document.getElementById('card-list-container');
    if (!container) return;
    
    // 检查是否已经存在进度条
    let progressBar = document.getElementById('card-loading-progress');
    if (!progressBar) {
      progressBar = document.createElement('div');
      progressBar.id = 'card-loading-progress';
      progressBar.style.cssText = `
        padding: 12px 16px;
        background: #f5f5f5;
        border-bottom: 1px solid #e0e0e0;
        position: sticky;
        top: 0;
        z-index: 10;
      `;
      
      progressBar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="flex: 1; background: #e0e0e0; height: 8px; border-radius: 4px; overflow: hidden;">
            <div id="card-progress-bar" style="background: #4caf50; height: 100%; width: 0%; transition: width 0.3s ease;"></div>
          </div>
          <div id="card-progress-text" style="font-size: 12px; color: #666; white-space: nowrap;">
            加载中... 0 / ${total}
          </div>
        </div>
        <div id="card-progress-current" style="font-size: 11px; color: #999; margin-top: 4px;"></div>
      `;
      
      container.insertBefore(progressBar, container.firstChild);
    }
  }
  
  // 更新进度
  function updateProgress(loaded, total, current) {
    const progressBar = document.getElementById('card-progress-bar');
    const progressText = document.getElementById('card-progress-text');
    const progressCurrent = document.getElementById('card-progress-current');
    
    if (progressBar) {
      const percentage = (loaded / total) * 100;
      progressBar.style.width = percentage + '%';
    }
    
    if (progressText) {
      progressText.textContent = `加载中... ${loaded} / ${total}`;
    }
    
    if (progressCurrent) {
      progressCurrent.textContent = current ? `正在加载: ${current}` : '';
    }
  }
  
  // 隐藏进度条
  function hideProgress() {
    const progressBar = document.getElementById('card-loading-progress');
    if (progressBar) {
      progressBar.style.display = 'none';
    }
  }
  
  // 预渲染卡片内容（包括下载 storage 并缓存到本地）
  async function preloadCardContent(card) {
    if (!card.content) {
      cardContentCache[String(card.docId)] = '<p style="color: #888;">暂无内容</p>';
      return;
    }
    
    try {
      // 渲染 markdown
      const response = await fetch('/markdown', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: card.content || '',
          inline: false,
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to render markdown');
      }
      
      let html = await response.text();
      
      // 预加载并缓存图片到本地
      html = await preloadAndCacheImages(html);
      
      // 如果内容中有图片，等待所有图片加载完成
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      const images = tempDiv.querySelectorAll('img');
      
      if (images.length > 0) {
        // 等待所有图片加载完成
        const imagePromises = Array.from(images).map(img => {
          return new Promise((resolve) => {
            if (img.complete) {
              resolve();
            } else {
              img.onload = resolve;
              img.onerror = resolve; // 即使失败也继续
              // 设置超时，避免无限等待
              setTimeout(resolve, 10000);
            }
          });
        });
        
        await Promise.all(imagePromises);
      }
      
      // 缓存渲染后的 HTML（包含本地 blob URL）
      cardContentCache[String(card.docId)] = html;
    } catch (error) {
      console.error(`Failed to preload card ${card.docId}:`, error);
      cardContentCache[String(card.docId)] = '<p style="color: #f44336;">加载内容失败</p>';
    }
  }
  
  // 加载当前节点的所有卡片（分批加载并预渲染内容）
  async function loadAllNodeCards() {
    if (!mindMap.bid && !mindMap.docId) {
      console.warn('Base data not found');
      return;
    }
    
    if (!nodeId) {
      console.warn('Node ID not found');
      return;
    }
    
    try {
      const domainId = window.UiContext?.domainId || 'system';
      const branch = window.UiContext?.currentBranch || 'main';
      const docId = mindMap.docId;
      const bid = mindMap.bid;
      
      // 先获取卡片总数（通过 API 获取）
      const cardApiUrl = docId
        ? `/d/${domainId}/base/${docId}/card?nodeId=${encodeURIComponent(nodeId)}`
        : `/d/${domainId}/base/bid/${bid}/card?nodeId=${encodeURIComponent(nodeId)}`;
      
      const cardResponse = await request.get(cardApiUrl);
      const allNodeCards = cardResponse.cards || [];
      
      // 过滤掉已经加载的卡片
      const existingCardIds = new Set(cards.map(c => String(c.docId)));
      const newCards = allNodeCards.filter(c => !existingCardIds.has(String(c.docId)));
      
      if (newCards.length === 0 && allNodeCards.length === cards.length) {
        // 没有新卡片，但需要预加载已有卡片的内容
        const totalCards = allNodeCards.length;
        if (totalCards === 0) {
          hideProgress();
          return;
        }
        
        // 检查哪些卡片还没有预加载内容
        const cardsToPreload = allNodeCards.filter(c => !cardContentCache[String(c.docId)]);
        
        if (cardsToPreload.length === 0) {
          hideProgress();
          return;
        }
        
        showProgress(totalCards);
        updateProgress(totalCards - cardsToPreload.length, totalCards, '');
        
        // 预加载卡片内容
        for (let i = 0; i < cardsToPreload.length; i++) {
          const card = cardsToPreload[i];
          updateProgress(totalCards - cardsToPreload.length + i + 1, totalCards, card.title || '未命名卡片');
          await preloadCardContent(card);
        }
        
        hideProgress();
        return;
      }
      
      const totalCards = allNodeCards.length;
      const alreadyLoaded = cards.length;
      
      // 显示进度条
      showProgress(totalCards);
      updateProgress(alreadyLoaded, totalCards, '');
      
      // 分批加载新卡片（每批 10 个）
      const batchSize = 10;
      for (let i = 0; i < newCards.length; i += batchSize) {
        const batch = newCards.slice(i, i + batchSize);
        const loaded = alreadyLoaded + Math.min(i + batchSize, newCards.length);
        
        // 更新进度
        updateProgress(loaded, totalCards, `正在加载卡片 ${loaded} / ${totalCards}`);
        
        // 添加卡片到列表
        batch.forEach((card, index) => {
          allCards.push(card);
          appendCardToContainer(card, alreadyLoaded + i + index + 1);
        });
        
        // 添加小延迟，让用户看到进度
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // 更新全局 cards 变量
      cards = allCards;
      
      // 预加载所有卡片的内容（包括已有和新加载的）
      const allCardsToPreload = allNodeCards.filter(c => !cardContentCache[String(c.docId)]);
      for (let i = 0; i < allCardsToPreload.length; i++) {
        const card = allCardsToPreload[i];
        const progress = totalCards - allCardsToPreload.length + i + 1;
        updateProgress(progress, totalCards, `正在预加载: ${card.title || '未命名卡片'}`);
        await preloadCardContent(card);
      }
      
      // 隐藏进度条
      hideProgress();
      
      // 重新设置拖动功能
      setupDragAndDrop();
    } catch (error) {
      console.error('Failed to load all node cards:', error);
      hideProgress();
    }
  }
  
  // 将单个卡片追加到容器
  function appendCardToContainer(card, order) {
    const container = document.getElementById('card-list-container');
    if (!container) return;
    
    const progressBar = document.getElementById('card-loading-progress');
    
    const cardItem = document.createElement('div');
    cardItem.className = 'base-card-list__item card-item';
    cardItem.setAttribute('data-card-id', card.docId);
    cardItem.setAttribute('data-order', card.order || order);
    
    cardItem.innerHTML = `
      <div class="base-card-list__item-content">
        <input 
          type="checkbox" 
          class="base-card-list__checkbox card-checkbox" 
          data-card-id="${card.docId}"
        />
        <span class="base-card-list__drag-handle drag-handle">⋮⋮</span>
        <div class="base-card-list__item-title">
          ${card.title || '未命名卡片'}
        </div>
      </div>
    `;
    
    // 添加点击事件
    cardItem.addEventListener('click', function(e) {
      // 如果点击的是复选框，不阻止事件
      if (e.target.classList.contains('card-checkbox')) {
        return;
      }
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
    
    // 为复选框添加点击事件，阻止冒泡
    const checkbox = cardItem.querySelector('.card-checkbox');
    if (checkbox) {
      checkbox.addEventListener('click', function(e) {
        e.stopPropagation();
      });
    }
    
    // 插入到进度条之后（如果存在）或直接追加
    if (progressBar && progressBar.nextSibling) {
      container.insertBefore(cardItem, progressBar.nextSibling);
    } else {
      container.appendChild(cardItem);
    }
  }
  
  // 定义 loadCard 函数
  function loadCard(cardId) {
    // 从所有卡片中查找（包括从其他节点加载的）
    const card = allCards.find(c => {
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
    
    // 更新内容（优先使用缓存）
    const contentDiv = document.getElementById('card-content');
    if (!contentDiv) return;
    
    const cardIdStr = String(cardId);
    
    // 为图片添加点击预览功能的辅助函数
    const attachImagePreviewHandlers = (container) => {
      const images = container.querySelectorAll('img');
      images.forEach((img) => {
        // 移除之前可能存在的监听器（避免重复添加）
        const newImg = img.cloneNode(true);
        img.parentNode?.replaceChild(newImg, img);
        
        // 添加点击事件
        newImg.style.cursor = 'pointer';
        newImg.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const imageUrl = newImg.src || newImg.getAttribute('src') || '';
          if (!imageUrl) return;
          
          try {
            // 使用 previewImage 函数预览图片
            const previewImage = window.Ejunz?.components?.preview?.previewImage;
            if (previewImage) {
              await previewImage(imageUrl);
            } else {
              // 如果 previewImage 不可用，使用 InfoDialog 作为后备方案
              const { InfoDialog } = await import('vj/components/dialog/index');
              const $ = (await import('jquery')).default;
              const isMobile = window.innerWidth <= 600;
              const maxHeight = isMobile ? 'calc(90vh - 60px)' : 'calc(80vh - 45px)';
              const padding = isMobile ? '10px' : '20px';
              
              const $img = $(`<img src="${imageUrl}" style="max-width: 100%; max-height: ${maxHeight}; width: auto; height: auto; cursor: pointer;" />`);
              $img.on('click', function() {
                const $this = $(this);
                if ($this.css('max-height') === 'none') {
                  $this.css('max-height', maxHeight);
                } else {
                  $this.css('max-height', 'none');
                }
              });
              
              const dialog = new InfoDialog({
                $body: $(`<div class="typo" style="padding: ${padding}; text-align: center;"></div>`).append($img),
                $action: null, // 不要按钮
                cancelByClickingBack: true,
                cancelByEsc: true,
              });
              await dialog.open();
            }
          } catch (error) {
            console.error('预览图片失败:', error);
            Notification.error('预览图片失败');
          }
        });
      });
    };

    // 检查缓存
    if (cardContentCache[cardIdStr]) {
      // 直接使用缓存的内容（图片已缓存到本地）
      contentDiv.innerHTML = cardContentCache[cardIdStr];
      attachImagePreviewHandlers(contentDiv);
    } else if (card.content) {
      // 缓存中没有，显示加载状态并渲染
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
      .then(async html => {
        // 预加载并缓存图片到本地
        html = await preloadAndCacheImages(html);
        // 缓存渲染结果
        cardContentCache[cardIdStr] = html;
        contentDiv.innerHTML = html;
        attachImagePreviewHandlers(contentDiv);
      })
      .catch(error => {
        console.error('Failed to render markdown:', error);
        const errorHtml = '<p style="color: #f44336;">加载内容失败</p>';
        cardContentCache[cardIdStr] = errorHtml;
        contentDiv.innerHTML = errorHtml;
      });
    } else {
      const emptyHtml = '<p style="color: #888;">暂无内容</p>';
      cardContentCache[cardIdStr] = emptyHtml;
      contentDiv.innerHTML = emptyHtml;
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
    
    // 更新编辑按钮的链接
    const editBtn = document.getElementById('card-edit-btn');
    if (editBtn) {
      const domainId = window.UiContext?.domainId || 'system';
      const branch = window.UiContext?.currentBranch || 'main';
      const docId = mindMap.docId;
      const bid = mindMap.bid;
      
      let editUrl;
      if (docId) {
        editUrl = `/d/${domainId}/base/${docId}/branch/${branch}/node/${encodeURIComponent(nodeId)}/card/${cardId}/edit`;
      } else if (bid) {
        editUrl = `/d/${domainId}/base/bid/${bid}/branch/${branch}/node/${encodeURIComponent(nodeId)}/card/${cardId}/edit`;
      }
      
      if (editUrl) {
        editBtn.href = editUrl;
        editBtn.style.display = 'inline-block';
      } else {
        editBtn.style.display = 'none';
      }
    }
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
    const deleteBtn = document.getElementById('delete-cards-btn');
    if (editBtn) editBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'inline-block';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    if (deleteBtn) deleteBtn.style.display = 'inline-block';
    
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
    const deleteBtn = document.getElementById('delete-cards-btn');
    if (editBtn) editBtn.style.display = 'inline-block';
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    
    // 取消所有复选框的选中状态
    document.querySelectorAll('.card-checkbox').forEach(checkbox => {
      checkbox.checked = false;
    });
    
    // 隐藏拖动手柄（通过 CSS 类控制）
    
    // 恢复原始顺序
    restoreOriginalOrder();
  }
  
  // 批量删除卡片
  async function deleteSelectedCards() {
    const selectedCheckboxes = document.querySelectorAll('.card-checkbox:checked');
    if (selectedCheckboxes.length === 0) {
      Notification.warn('请至少选择一个卡片');
      return;
    }
    
    const selectedCardIds = Array.from(selectedCheckboxes).map(checkbox => 
      checkbox.getAttribute('data-card-id')
    );
    
    if (!confirm(`确定要删除选中的 ${selectedCardIds.length} 个卡片吗？此操作不可恢复。`)) {
      return;
    }
    
    try {
      const domainId = window.UiContext?.domainId || 'system';
      
      // 批量删除
      for (const cardId of selectedCardIds) {
        const url = `/d/${domainId}/base/card/${cardId}`;
        await request.post(url, {
          operation: 'delete'
        });
      }
      
      Notification.success(`成功删除 ${selectedCardIds.length} 个卡片`);
      
      // 从列表中移除已删除的卡片
      selectedCardIds.forEach(cardId => {
        const cardItem = document.querySelector(`[data-card-id="${cardId}"]`);
        if (cardItem) {
          cardItem.remove();
        }
        // 从 allCards 中移除
        allCards = allCards.filter(c => {
          const cardDocId = c.docId ? (c.docId.toString ? c.docId.toString() : String(c.docId)) : null;
          return cardDocId !== cardId;
        });
        // 从缓存中移除
        delete cardContentCache[cardId];
      });
      
      // 如果当前选中的卡片被删除，加载第一个卡片
      const urlParams = new URLSearchParams(window.location.search);
      const currentCardId = urlParams.get('cardId');
      if (currentCardId && selectedCardIds.includes(currentCardId)) {
        if (allCards.length > 0) {
          const firstCardId = allCards[0].docId ? (allCards[0].docId.toString ? allCards[0].docId.toString() : String(allCards[0].docId)) : null;
          if (firstCardId) {
            loadCard(firstCardId);
          } else {
            // 如果没有卡片了，清空内容
            const titleElement = document.getElementById('card-title');
            const contentDiv = document.getElementById('card-content');
            if (titleElement) titleElement.textContent = '请选择卡片';
            if (contentDiv) contentDiv.innerHTML = '<p style="color: #888;">请从左侧选择一个卡片</p>';
            window.history.pushState({}, '', baseUrl);
          }
        } else {
          // 如果没有卡片了，清空内容
          const titleElement = document.getElementById('card-title');
          const contentDiv = document.getElementById('card-content');
          if (titleElement) titleElement.textContent = '请选择卡片';
          if (contentDiv) contentDiv.innerHTML = '<p style="color: #888;">请从左侧选择一个卡片</p>';
          window.history.pushState({}, '', baseUrl);
        }
      }
      
      // 退出编辑模式
      exitEditMode();
    } catch (error) {
      console.error('Failed to delete cards:', error);
      Notification.error('删除失败: ' + (error.message || '未知错误'));
    }
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
      const domainId = window.UiContext?.domainId || 'system';
      for (const update of updates) {
        // 使用正确的路由格式，确保 operation 在请求体中
        const url = `/d/${domainId}/base/card/${update.cardId}`;
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
          const itebiddle = rect.top + rect.height / 2;
          
          // 清除之前的样式
          document.querySelectorAll('.card-item').forEach(el => {
            if (el !== newItem) {
              el.style.borderTop = '';
              el.style.borderBottom = '';
            }
          });
          
          if (mouseY < itebiddle) {
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
            const itebiddle = rect.top + rect.height / 2;
            
            if (mouseY < itebiddle) {
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
        // 如果点击的是复选框，不阻止事件
        if (e.target.classList.contains('card-checkbox')) {
          return;
        }
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
      
      // 为复选框添加点击事件，阻止冒泡
      const checkbox = newItem.querySelector('.card-checkbox');
      if (checkbox) {
        checkbox.addEventListener('click', function(e) {
          e.stopPropagation();
        });
      }
    });
  }
  
  // 页面加载时，初始化事件监听器和加载卡片
  async function init() {
    // 初始化图片缓存
    await initImageCache();
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
    
    // 删除按钮
    const deleteBtn = document.getElementById('delete-cards-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', deleteSelectedCards);
    }
    
    // 为所有卡片项添加点击事件
    document.querySelectorAll('.card-item').forEach(item => {
      item.addEventListener('click', function(e) {
        // 如果点击的是复选框，不阻止事件
        if (e.target.classList.contains('card-checkbox')) {
          return;
        }
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
      
      // 为复选框添加点击事件，阻止冒泡
      const checkbox = item.querySelector('.card-checkbox');
      if (checkbox) {
        checkbox.addEventListener('click', function(e) {
          e.stopPropagation();
        });
      }
      
      // 悬停效果由 CSS 处理
    });
    
    // 检查 URL 参数并加载对应卡片
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    if (cardId && allCards.length > 0) {
      // 如果 URL 中有 cardId，加载对应的卡片
      loadCard(cardId);
    } else if (allCards.length > 0) {
      // 如果没有 cardId，加载第一个卡片并更新 URL
      const firstCardId = allCards[0].docId ? (allCards[0].docId.toString ? allCards[0].docId.toString() : String(allCards[0].docId)) : null;
      if (firstCardId) {
        loadCard(firstCardId);
      }
    }
    
    // 开始加载当前节点的所有卡片
    loadAllNodeCards();
  }
  
  // 处理浏览器前进/后退
  window.addEventListener('popstate', function(event) {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    if (cardId) {
      loadCard(cardId);
    } else if (allCards.length > 0) {
      // 如果没有 cardId，加载第一个卡片
      const firstCardId = allCards[0].docId ? (allCards[0].docId.toString ? allCards[0].docId.toString() : String(allCards[0].docId)) : null;
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


import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';

// 树形结构样式
const treeStyles = `
<style>
.doc-tree ul {
  list-style: none;
  padding-left: 0;
  margin: 0;
}
.doc-tree li {
  margin: 0;
  padding: 0;
}
.doc-tree-item {
  padding: 4px 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  border-radius: 3px;
  transition: background-color 0.2s;
  margin: 1px 0;
}
.doc-tree-item:hover {
  background-color: #f0f0f0;
}
.doc-tree-item.active {
  background-color: #e3f2fd;
  font-weight: 600;
}
.doc-tree-item.dragging {
  opacity: 0.5;
  background-color: #e0e0e0;
}
.doc-tree-item.drag-over {
  background-color: #bbdefb;
  border: 2px dashed #2196F3;
}
.doc-tree-item.drop-before {
  border-top: 3px solid #1976D2;
  border-bottom: 2px dashed transparent;
}
.doc-tree-item.drop-after {
  border-bottom: 3px solid #1976D2;
  border-top: 2px dashed transparent;
}
.doc-tree-item.drop-inside {
  box-shadow: inset 0 0 0 2px #64b5f6;
}
.doc-tree-toggle {
  width: 16px;
  height: 16px;
  margin-right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}
.doc-tree-toggle:before {
  content: '▶';
  font-size: 10px;
  color: #666;
  transition: transform 0.2s;
}
.doc-tree-toggle.expanded:before {
  transform: rotate(90deg);
}
.doc-tree-toggle.leaf {
  opacity: 0;
  pointer-events: none;
}
.doc-tree-icon {
  margin-right: 6px;
  flex-shrink: 0;
  font-size: 16px;
}
.doc-tree-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-tree-label a {
  color: #333;
  text-decoration: none;
  pointer-events: auto;
}
.edit-mode .doc-tree-label a {
  pointer-events: none;
  color: #888;
}
.doc-tree-label a:not(.edit-mode):hover {
  color: #2196F3;
  text-decoration: underline;
}
.doc-tree-children {
  padding-left: 20px;
  display: none;
  margin-top: 1px;
}
.doc-tree-children.expanded {
  display: block;
}
.doc-tree-block {
  font-size: 13px;
}
.doc-tree-block .doc-tree-icon {
  font-size: 14px;
}
.tree-edit-controls {
  margin-bottom: 10px;
  display: flex;
  gap: 8px;
}
.tree-edit-controls button {
  padding: 6px 12px;
  font-size: 13px;
  border-radius: 3px;
  border: 1px solid #ccc;
  background: #fff;
  cursor: pointer;
}
.tree-edit-controls button:hover {
  background: #f0f0f0;
}
.tree-edit-controls button.primary {
  background: #2196F3;
  color: white;
  border-color: #2196F3;
}
.tree-edit-controls button.primary:hover {
  background: #1976D2;
}
.tree-edit-controls button.success {
  background: #4CAF50;
  color: white;
  border-color: #4CAF50;
}
.tree-edit-controls button.success:hover {
  background: #45a049;
}
.delete-zone {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  width: 300px;
  min-height: 60px;
  background-color: #ffebee;
  border: 3px dashed #f44336;
  border-radius: 8px;
  padding: 15px;
  text-align: center;
  color: #c62828;
  font-weight: 500;
  z-index: 1000;
  display: none;
  transition: all 0.3s;
}
.delete-zone.visible {
  display: block;
}
.delete-zone.drag-over {
  background-color: #ffcdd2;
  border-color: #d32f2f;
  transform: translateX(-50%) scale(1.05);
}
.delete-zone .delete-items {
  margin-top: 10px;
  font-size: 12px;
  color: #c62828;
}
.delete-zone .delete-item {
  display: inline-block;
  background: white;
  padding: 4px 8px;
  margin: 2px;
  border-radius: 3px;
  border: 1px solid #f44336;
}
.doc-tree-item.new-item {
  border: 2px dashed #999;
  opacity: 0.9;
  background-color: #f9f9f9;
  min-height: 36px;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 500;
}
.doc-tree-item.new-item-placeholder {
  border: 2px dashed #2196F3;
  background-color: #e3f2fd;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #2196F3;
  font-style: italic;
  font-size: 14px;
  padding: 10px;
}
.edit-mode .doc-tree-item.new-item {
  cursor: grab;
  border-color: #2196F3;
  background-color: #e3f2fd;
  color: #2196F3;
}
.edit-mode .doc-tree-item.new-item:hover {
  background-color: #bbdefb;
  border-color: #1976D2;
}
.edit-mode .doc-tree-item.new-item:active {
  cursor: grabbing;
}
.title-input-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  z-index: 10000;
  min-width: 300px;
}
.title-input-dialog input {
  width: 100%;
  padding: 8px;
  font-size: 14px;
  border: 1px solid #ccc;
  border-radius: 4px;
  margin-bottom: 10px;
}
.title-input-dialog-buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.title-input-dialog button {
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid #ccc;
  cursor: pointer;
}
.title-input-dialog button.primary {
  background: #2196F3;
  color: white;
  border-color: #2196F3;
}
</style>
`;

// 文档树和拖拽编辑功能
import $ from 'jquery';
import _ from 'lodash';
import { pjax } from 'vj/utils';

export default new AutoloadPage('repo_detail,repo_map,doc_detail,block_detail', async () => {
    // 注入样式
    if (!document.getElementById('doc-tree-styles')) {
      const styleEl = document.createElement('div');
      styleEl.id = 'doc-tree-styles';
      styleEl.innerHTML = treeStyles;
      document.head.appendChild(styleEl.firstElementChild);
    }

    const treeData = UiContext.docHierarchy;
    const repo = UiContext.repo;
    const currentDocId = UiContext.ddoc?.docId ? (typeof UiContext.ddoc.docId === 'string' ? UiContext.ddoc.docId : UiContext.ddoc.docId.toString()) : '';
    const currentBlockDocId = UiContext.block?.docId ? (typeof UiContext.block.docId === 'string' ? UiContext.block.docId : UiContext.block.docId.toString()) : '';
    // 从UiContext获取currentBranch，如果没有则从repo对象获取
    const currentBranch = (UiContext && UiContext.currentBranch) || (repo && (repo.currentBranch || 'main')) || 'main';
    
    if (!treeData || !repo) {
      return;
    }

    const container = document.getElementById('doc-tree-container');
    if (!container) return;

    // 从后端数据中获取所有 docs 的 blocks
    const allDocsWithBlocks = UiContext.allDocsWithBlocks || {};

    let isEditMode = false;
    let draggedElement = null;
    let draggedData = null;
    let pendingCreates = []; // 待创建的项目列表
    let pendingDeletes = []; // 待删除的项目列表 { type: 'doc'|'block', docId: string }
    let pendingUpdates = []; // 待更新的标题列表 { type: 'doc'|'block', docId: string, title: string }

    // 添加编辑控制按钮
    function renderEditControls() {
      const controlsDiv = document.createElement('div');
      controlsDiv.className = 'tree-edit-controls';
      controlsDiv.id = 'tree-edit-controls';

      const editBtn = document.createElement('button');
      editBtn.textContent = '编辑模式';
      editBtn.className = 'primary';
      editBtn.onclick = () => {
        isEditMode = true;
        container.classList.add('edit-mode');
        editBtn.style.display = 'none';
        saveBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'inline-block';
        const deleteZone = createDeleteZone();
        if (deleteZone) {
          deleteZone.classList.add('visible');
        }
        renderTree();
      };

      const saveBtn = document.createElement('button');
      saveBtn.textContent = '保存';
      saveBtn.className = 'success';
      saveBtn.style.display = 'none';
      saveBtn.onclick = () => {
        saveStructure();
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.display = 'none';
      cancelBtn.onclick = () => {
        isEditMode = false;
        container.classList.remove('edit-mode');
        editBtn.style.display = 'inline-block';
        saveBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        pendingCreates = [];
        pendingDeletes = [];
        pendingUpdates = [];
        updateDeleteZone();
        // 隐藏删除区域
        const deleteZone = document.getElementById('delete-zone');
        if (deleteZone) {
          deleteZone.classList.remove('visible');
        }
        // 恢复所有被标记为删除的元素的显示
        document.querySelectorAll('.doc-tree-item').forEach(el => {
          el.style.opacity = '';
          el.style.textDecoration = '';
        });
        renderTree();
      };

      const newDocBtn = document.createElement('button');
      newDocBtn.textContent = '+ 新建 Doc';
      newDocBtn.style.display = 'none';
      newDocBtn.onclick = () => {
        createNewItemPlaceholder('doc');
      };

      const newBlockBtn = document.createElement('button');
      newBlockBtn.textContent = '+ 新建 Block';
      newBlockBtn.style.display = 'none';
      newBlockBtn.onclick = () => {
        createNewItemPlaceholder('block');
      };

      // 编辑模式切换时显示/隐藏新建按钮
      const originalEditOnClick = editBtn.onclick;
      editBtn.onclick = () => {
        originalEditOnClick();
        newDocBtn.style.display = 'inline-block';
        newBlockBtn.style.display = 'inline-block';
      };

      const originalCancelOnClick = cancelBtn.onclick;
      cancelBtn.onclick = () => {
        originalCancelOnClick();
        newDocBtn.style.display = 'none';
        newBlockBtn.style.display = 'none';
        pendingDeletes = [];
        updateDeleteZone();
      };

      controlsDiv.appendChild(editBtn);
      controlsDiv.appendChild(saveBtn);
      controlsDiv.appendChild(cancelBtn);
      controlsDiv.appendChild(newDocBtn);
      controlsDiv.appendChild(newBlockBtn);

      return controlsDiv;
    }

    // 创建删除区域
    function createDeleteZone() {
      let deleteZone = document.getElementById('delete-zone');
      if (!deleteZone) {
        deleteZone = document.createElement('div');
        deleteZone.id = 'delete-zone';
        deleteZone.className = 'delete-zone';
        deleteZone.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 5px;">🗑️ 拖拽到此处删除</div>
          <div class="delete-items"></div>
        `;
        document.body.appendChild(deleteZone);
        
        // 删除区域的拖拽事件
        deleteZone.ondragover = (e) => {
          e.preventDefault();
          e.stopPropagation();
          deleteZone.classList.add('drag-over');
          return false;
        };
        
        deleteZone.ondragleave = (e) => {
          e.preventDefault();
          deleteZone.classList.remove('drag-over');
        };
        
        deleteZone.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          deleteZone.classList.remove('drag-over');
          
          if (draggedData && draggedElement) {
            // 不能删除待创建的项目（占位符）
            if (draggedData.placeholderId) {
              alert('不能删除未保存的项目');
              return false;
            }
            
            // 添加到删除列表
            const deleteItem = {
              type: draggedData.type,
              docId: draggedData.docId || ''
            };
            
            // 检查是否已存在
            const exists = pendingDeletes.some(d => 
              d.type === deleteItem.type && d.docId === deleteItem.docId
            );
            
            if (!exists) {
              pendingDeletes.push(deleteItem);
              
              // 如果删除的是doc，自动收集其下的所有blocks并添加到删除列表
              if (deleteItem.type === 'doc') {
                const docBlocks = allDocsWithBlocks[deleteItem.docId] || [];
                docBlocks.forEach(block => {
                  const blockDocId = block.docId ? (typeof block.docId === 'string' ? block.docId : block.docId.toString()) : '';
                  // 检查block是否已经在删除列表中
                  const blockExists = pendingDeletes.some(d => 
                    d.type === 'block' && d.docId === blockDocId
                  );
                  if (!blockExists && blockDocId) {
                    pendingDeletes.push({
                      type: 'block',
                      docId: blockDocId
                    });
                  }
                });
              }
              
              updateDeleteZone();
              
              // 从树中移除（但不删除 DOM，因为可能取消）
              draggedElement.style.opacity = '0.3';
              draggedElement.style.textDecoration = 'line-through';
            }
          }
          
          draggedElement = null;
          draggedData = null;
          return false;
        };
      }
      return deleteZone;
    }

    // 更新删除区域显示
    function updateDeleteZone() {
      const deleteZone = document.getElementById('delete-zone');
      if (!deleteZone) return;
      
      const deleteItemsDiv = deleteZone.querySelector('.delete-items');
      if (!deleteItemsDiv) return;
      
      if (pendingDeletes.length === 0) {
        deleteItemsDiv.innerHTML = '';
      } else {
        deleteItemsDiv.innerHTML = pendingDeletes.map(item => {
          if (item.type === 'doc') {
            const blockCount = allDocsWithBlocks[item.docId]?.length || 0;
            return `<span class="delete-item">📁 Doc (docId: ${item.docId})${blockCount > 0 ? ` + ${blockCount} blocks` : ''}</span>`;
          } else {
            return `<span class="delete-item">📝 Block (docId: ${item.docId})</span>`;
          }
        }).join('');
      }
    }

    // 创建新项占位符
    function createNewItemPlaceholder(type) {
      const placeholderId = `new-${type}-${Date.now()}`;
      const placeholder = {
        id: placeholderId,
        type: type,
        title: '',
        parentDocId: null,
        order: 0
      };

      // 创建占位符元素
      const placeholderDiv = document.createElement('div');
      placeholderDiv.className = 'doc-tree-item new-item';
      placeholderDiv.dataset.type = `new-${type}`;
      placeholderDiv.dataset.placeholderId = placeholderId;
      placeholderDiv.draggable = true;
      
      const icon = document.createElement('span');
      icon.className = 'doc-tree-icon';
      icon.innerHTML = type === 'doc' ? '📁' : '📝';
      placeholderDiv.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'doc-tree-label';
      label.textContent = placeholder.title || `[新建 ${placeholder.type === 'doc' ? 'Doc' : 'Block'}]`;
      label.style.color = placeholder.title ? '#333' : '#2196F3';
      label.style.fontWeight = placeholder.title ? '500' : '500';
      label.style.fontSize = '14px';
      placeholderDiv.appendChild(label);

      // 双击事件：输入标题
      placeholderDiv.ondblclick = (e) => {
        e.stopPropagation();
        const placeholderId = placeholderDiv.dataset.placeholderId;
        const placeholder = pendingCreates.find(p => p.id === placeholderId);
        if (!placeholder) return;
        
        // 确定父节点信息
        let parentDocId = null;
        if (placeholder.parentPlaceholderId) {
          parentDocId = placeholder.parentPlaceholderId;
        } else {
          parentDocId = placeholder.parentDocId;
        }
        
        const type = placeholderDiv.dataset.type.replace('new-', '');
        const li = placeholderDiv.closest('li');
        showTitleInputDialog(placeholderId, type, parentDocId, li, null);
      };

      // 拖拽事件
      placeholderDiv.ondragstart = handleDragStart;
      placeholderDiv.ondragover = handleDragOver;
      placeholderDiv.ondragenter = handleDragEnter;
      placeholderDiv.ondragleave = handleDragLeave;
      placeholderDiv.ondrop = handleDrop;
      placeholderDiv.ondragend = handleDragEnd;

      // 添加到待创建列表
      pendingCreates.push(placeholder);
      
      // 重新渲染树，让占位符显示在正确位置
      renderTree();
    }

    // 保存新结构
    async function saveStructure() {
      // 生成默认 commit message: domainId/userId/username（不可修改）
      const userInfo = UiContext.userInfo || {};
      const defaultPrefix = `${userInfo.domainId || repo.domainId || 'system'}/${userInfo.userId || 0}/${userInfo.userName || 'unknown'}`;
      
      // 提示用户输入自定义消息（默认部分不可修改）
      const customMessage = window.prompt(`请输入自定义提交消息（可选）：\n默认消息：${defaultPrefix}`, '');
      if (customMessage === null) {
        // 用户取消了
        return;
      }
      // 只发送自定义部分，后端会组合默认前缀
      const customPart = customMessage.trim() || '';

      const structure = collectStructure();
      const creates = collectPendingCreates(structure);
      
      try {
        // 使用带branch的URL，确保branch参数正确传递到handler
        const updateUrl = `/d/${repo.domainId}/base/repo/${repo.rpid}/branch/${currentBranch}/update_structure`;
        const response = await fetch(updateUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ structure, creates, deletes: pendingDeletes, updates: pendingUpdates, commitMessage: customPart }),
        });

        if (response.ok) {
          const result = await response.json();
          if (result.commitSuccess === false) {
            if (result.commitError) {
              alert('保存成功，但提交失败：' + result.commitError + '\n\n数据库已更新，但本地文件可能未同步。');
            } else {
              alert('保存成功，但未检测到文件变化，因此未创建新的 commit。\n\n如果确实有变化，请使用"同步本地文件"按钮。');
            }
          } else {
            alert('保存成功并已提交！');
          }
          location.reload();
        } else {
          const error = await response.json();
          alert('保存失败：' + (error.message || '未知错误'));
        }
      } catch (err) {
        alert('保存失败：' + err.message);
      }
    }

    // 收集所有待创建的项目
    function collectPendingCreates(structure) {
      const creates = [];
      
      // 收集根层级的待创建项
      if (structure.pendingCreates) {
        creates.push(...structure.pendingCreates);
      }
      
      function traverse(docStructure) {
        if (docStructure.pendingCreates) {
          docStructure.pendingCreates.forEach(create => {
            creates.push(create);
          });
        }
        if (docStructure.subDocs) {
          docStructure.subDocs.forEach(subDoc => {
            traverse(subDoc);
          });
        }
      }

      structure.docs.forEach(doc => traverse(doc));
      return creates;
    }

    // 收集当前结构 (v3 - bid is unique per repo)
    function collectStructure() {
      const structure = {
        docs: [],
        blocks: {}
      };

      const rootUl = container.querySelector('.doc-tree > ul');
      if (!rootUl) return structure;

      const docItems = Array.from(rootUl.children).filter(li => {
        const item = li.querySelector('.doc-tree-item');
        if (!item) return false;
        // 排除已标记为删除的项目
        if (item.style.opacity === '0.3' || item.style.textDecoration === 'line-through') {
          return false;
        }
        return item && item.dataset.type === 'doc';
      });

      docItems.forEach((li, index) => {
        const itemDiv = li.querySelector('.doc-tree-item');
        const docId = itemDiv.dataset.docId || '';
        const docStructure = {
          docId: docId,
          order: index,
          subDocs: []
        };

        // 收集子文档和 blocks
        collectChildren(li, docStructure);
        structure.docs.push(docStructure);
      });

      // 收集根层级的待创建项
      const rootItems = Array.from(rootUl.children).filter(li => {
        const item = li.querySelector('.doc-tree-item');
        return item && item.dataset.type && item.dataset.type.startsWith('new-');
      });

      if (rootItems.length > 0 && !structure.pendingCreates) {
        structure.pendingCreates = [];
      }

      rootItems.forEach((li, index) => {
        const itemDiv = li.querySelector('.doc-tree-item');
        const placeholderId = itemDiv.dataset.placeholderId;
        const placeholder = pendingCreates.find(p => p.id === placeholderId);
        if (placeholder && placeholder.title) {
          const placeholderDoc = {
            type: placeholder.type,
            title: placeholder.title,
            parentDocId: null, // 根层级
            parentPlaceholderId: null,
            placeholderId: placeholder.id, // 添加 placeholderId 用于后端映射
            order: index
          };
          
          // 收集占位符 doc 下的子节点
          const subDoc = {
            placeholderId: placeholderId,
            order: index,
            subDocs: []
          };
          collectChildren(li, subDoc);
          
          // 如果占位符 doc 下有 pendingCreates，将它们添加到根级别
          if (subDoc.pendingCreates && subDoc.pendingCreates.length > 0) {
            structure.pendingCreates.push(...subDoc.pendingCreates);
          }
          
          structure.pendingCreates.push(placeholderDoc);
        }
      });

      // 递归收集所有嵌套的 pendingCreates
      function collectAllPendingCreates(structure) {
        if (!structure.pendingCreates) {
          structure.pendingCreates = [];
        }
        
        // 如果是 doc 结构，递归收集子 doc 的 pendingCreates
        if (structure.subDocs) {
          structure.subDocs.forEach(subDoc => {
            // 如果子 doc 是占位符 doc（有 placeholderId），需要确保它被添加到 pendingCreates
            if (subDoc.placeholderId) {
              const placeholder = pendingCreates.find(p => p.id === subDoc.placeholderId);
              if (placeholder && placeholder.title) {
                // 检查是否已经在 pendingCreates 中
                const exists = structure.pendingCreates.some(p => p.placeholderId === subDoc.placeholderId);
                if (!exists) {
                  // 确定父节点 ID
                  let actualParentDocId = null;
                  let actualParentPlaceholderId = null;
                  
                  if (placeholder.parentPlaceholderId) {
                    actualParentPlaceholderId = placeholder.parentPlaceholderId;
                  } else if (placeholder.parentDocId) {
                    actualParentDocId = placeholder.parentDocId;
                  } else {
                    // 从当前结构获取
                    if (structure.docId) {
                      actualParentDocId = structure.docId;
                    } else if (structure.placeholderId) {
                      actualParentPlaceholderId = structure.placeholderId;
                    }
                  }
                  
                  structure.pendingCreates.push({
                    type: placeholder.type,
                    title: placeholder.title,
                    parentDocId: actualParentDocId,
                    parentPlaceholderId: actualParentPlaceholderId,
                    placeholderId: placeholder.id,
                    order: subDoc.order
                  });
                }
              }
            }
            
            // 收集子 doc 的 pendingCreates（包括占位符 doc 下的 block）
            if (subDoc.pendingCreates && subDoc.pendingCreates.length > 0) {
              structure.pendingCreates.push(...subDoc.pendingCreates);
              // 清空子 doc 的 pendingCreates，避免重复
              subDoc.pendingCreates = [];
            }
            // 递归处理
            collectAllPendingCreates(subDoc);
          });
        }
      }
      
      // 收集所有嵌套的 pendingCreates
      structure.docs.forEach(doc => collectAllPendingCreates(doc));
      
      return structure;
    }

    function collectChildren(li, parentStructure) {
      const childrenDiv = li.querySelector(':scope > .doc-tree-children');
      if (!childrenDiv) return;

      const childrenUl = childrenDiv.querySelector('ul');
      if (!childrenUl) return;

      const children = Array.from(childrenUl.children);
      
      children.forEach((childLi, index) => {
        const itemDiv = childLi.querySelector('.doc-tree-item');
        if (!itemDiv) return;
        
        // 排除已标记为删除的项目
        if (itemDiv.style.opacity === '0.3' || itemDiv.style.textDecoration === 'line-through') {
          return;
        }
        
        const type = itemDiv.dataset.type;

        if (type === 'doc') {
          const docId = itemDiv.dataset.docId || '';
          const subDoc = {
            docId: docId,
            order: index,
            subDocs: []
          };
          collectChildren(childLi, subDoc);
          parentStructure.subDocs.push(subDoc);
        } else if (type === 'block') {
          const blockDocId = itemDiv.dataset.docId || '';
          if (!parentStructure.blocks) {
            parentStructure.blocks = [];
          }
          const blockData = {
            docId: blockDocId,
            order: index
          };
          parentStructure.blocks.push(blockData);
        } else if (type === 'new-doc') {
          // 占位符 doc
          const placeholderId = itemDiv.dataset.placeholderId;
          const placeholder = pendingCreates.find(p => p.id === placeholderId);
          if (placeholder && placeholder.title) {
            // 确定父节点 ID
            let actualParentDid = null;
            let actualParentPlaceholderId = null;
            
            // 优先使用 placeholder 中记录的父节点信息
            if (placeholder.parentPlaceholderId) {
              actualParentPlaceholderId = placeholder.parentPlaceholderId;
            } else if (placeholder.parentDid) {
              actualParentDid = placeholder.parentDid;
            } else {
              // 从 parentStructure 获取
              if (parentStructure.docId) {
                actualParentDocId = parentStructure.docId;
              } else if (parentStructure.placeholderId) {
                actualParentPlaceholderId = parentStructure.placeholderId;
              }
            }
            
            // 将占位符 doc 添加到 pendingCreates
            if (!parentStructure.pendingCreates) {
              parentStructure.pendingCreates = [];
            }
            parentStructure.pendingCreates.push({
              type: placeholder.type,
              title: placeholder.title,
              parentDid: actualParentDid,
              parentPlaceholderId: actualParentPlaceholderId,
              placeholderId: placeholder.id,
              order: index
            });
            
            const subDoc = {
              placeholderId: placeholderId, // 标识这是占位符 doc
              order: index,
              subDocs: []
            };
            collectChildren(childLi, subDoc);
            
            // 如果占位符 doc 下有 pendingCreates，将它们也添加到父级的 pendingCreates
            if (subDoc.pendingCreates && subDoc.pendingCreates.length > 0) {
              parentStructure.pendingCreates.push(...subDoc.pendingCreates);
              subDoc.pendingCreates = [];
            }
            
            if (!parentStructure.subDocs) {
              parentStructure.subDocs = [];
            }
            parentStructure.subDocs.push(subDoc);
          }
        } else if (type === 'new-block') {
          // 待创建的 block
          const placeholderId = itemDiv.dataset.placeholderId;
          const placeholder = pendingCreates.find(p => p.id === placeholderId);
          if (placeholder && placeholder.title) {
            if (!parentStructure.pendingCreates) {
              parentStructure.pendingCreates = [];
            }
            
            // 确定父节点 ID
            let actualParentDid = null;
            let actualParentPlaceholderId = null;
            
            // 优先使用 placeholder 中记录的父节点信息
            if (placeholder.parentPlaceholderId) {
              // 父节点是占位符 doc，使用 placeholderId
              actualParentPlaceholderId = placeholder.parentPlaceholderId;
            } else if (placeholder.parentDid) {
              // 父节点是已存在的 doc
              actualParentDid = placeholder.parentDid;
            } else {
              // 没有明确记录父节点，尝试从 parentStructure 获取
              if (parentStructure.did) {
                // parentStructure 是已存在的 doc
                actualParentDid = parentStructure.did;
              } else if (parentStructure.placeholderId) {
                // parentStructure 是占位符 doc
                actualParentPlaceholderId = parentStructure.placeholderId;
              }
            }
            
            parentStructure.pendingCreates.push({
              type: placeholder.type,
              title: placeholder.title,
              parentDid: actualParentDid,
              parentPlaceholderId: actualParentPlaceholderId,
              placeholderId: placeholder.id, // 添加 placeholderId 用于后端映射
              order: index
            });
          }
        } else if (type && type.startsWith('new-')) {
          // 其他类型的待创建项目（兼容旧代码）
          const placeholderId = itemDiv.dataset.placeholderId;
          const placeholder = pendingCreates.find(p => p.id === placeholderId);
          if (placeholder && placeholder.title) {
            if (!parentStructure.pendingCreates) {
              parentStructure.pendingCreates = [];
            }
            
            // 确定父节点 ID
            let actualParentDid = null;
            let actualParentPlaceholderId = null;
            
            if (placeholder.parentPlaceholderId) {
              // 父节点是占位符 doc，使用 placeholderId
              actualParentPlaceholderId = placeholder.parentPlaceholderId;
            } else if (placeholder.parentDid) {
              // 父节点是已存在的 doc
              actualParentDid = placeholder.parentDid;
            } else {
              // 没有明确记录父节点，尝试从 parentStructure 获取
              if (parentStructure.did) {
                // parentStructure 是已存在的 doc
                actualParentDid = parentStructure.did;
              } else if (parentStructure.placeholderId) {
                // parentStructure 是占位符 doc
                actualParentPlaceholderId = parentStructure.placeholderId;
              }
            }
            
            parentStructure.pendingCreates.push({
              type: placeholder.type,
              title: placeholder.title,
              parentDid: actualParentDid,
              parentPlaceholderId: actualParentPlaceholderId,
              placeholderId: placeholder.id, // 添加 placeholderId 用于后端映射
              order: index
            });
          }
        }
      });
    }

    // 渲染树节点
    function renderTreeNode(doc, isRoot = false) {
      const docId = doc.docId ? (typeof doc.docId === 'string' ? doc.docId : doc.docId.toString()) : '';
      const hasChildren = doc.subDocs && doc.subDocs.length > 0;
      const hasBlocks = docId && allDocsWithBlocks[docId] && allDocsWithBlocks[docId].length > 0;
      const isActiveDoc = docId === currentDocId;
      
      const li = document.createElement('li');
      li.dataset.type = 'doc';
      li.dataset.docId = docId;
      
      // 文档节点
      const itemDiv = document.createElement('div');
      itemDiv.className = `doc-tree-item${isActiveDoc ? ' active' : ''}`;
      itemDiv.dataset.type = 'doc';
      itemDiv.dataset.docId = docId;
      itemDiv.dataset.rpid = repo.rpid;
      
      // 检查是否在删除列表中
      const isDeleted = pendingDeletes.some(d => d.type === 'doc' && d.docId === docId);
      if (isDeleted) {
        itemDiv.style.opacity = '0.3';
        itemDiv.style.textDecoration = 'line-through';
      }

      // 在编辑模式下启用拖拽
      if (isEditMode) {
        itemDiv.draggable = true;
        itemDiv.ondragstart = handleDragStart;
        itemDiv.ondragover = handleDragOver;
        itemDiv.ondragenter = handleDragEnter;
        itemDiv.ondragleave = handleDragLeave;
        itemDiv.ondrop = handleDrop;
        itemDiv.ondragend = handleDragEnd;
        // 双击重命名
        itemDiv.ondblclick = (e) => {
          e.stopPropagation();
          const currentTitle = doc.title;
          showRenameDialog('doc', docId, undefined, currentTitle);
        };
      }
      
      // 折叠/展开按钮
      const toggle = document.createElement('span');
      toggle.className = `doc-tree-toggle${(!hasChildren && !hasBlocks) ? ' leaf' : ' expanded'}`;
      toggle.onclick = (e) => {
        e.stopPropagation();
        toggle.classList.toggle('expanded');
        const children = li.querySelector('.doc-tree-children');
        if (children) {
          children.classList.toggle('expanded');
        }
      };
      itemDiv.appendChild(toggle);
      
      // 文件夹图标（所有 doc 统一使用文件夹图标）
      const icon = document.createElement('span');
      icon.className = 'doc-tree-icon';
      icon.innerHTML = '📁';
      itemDiv.appendChild(icon);
      
      // 文档标题链接
      const label = document.createElement('span');
      label.className = 'doc-tree-label';
      const link = document.createElement('a');
      link.href = doc.url;
      // 检查是否有待更新的标题
      const pendingUpdate = pendingUpdates.find(u => u.type === 'doc' && u.docId === docId);
      link.textContent = pendingUpdate ? pendingUpdate.title : doc.title;
      if (!isEditMode) {
        link.onclick = (e) => {
          if (e.ctrlKey || e.metaKey) {
            return; // 允许在新标签页打开
          }
        };
      }
      label.appendChild(link);
      itemDiv.appendChild(label);
      
      li.appendChild(itemDiv);
      
      // 子文档和 blocks
      if (hasChildren || hasBlocks) {
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'doc-tree-children expanded';
        const childrenUl = document.createElement('ul');
        
        // 渲染子文档（现在所有doc都是根doc，不应该有子文档）
        if (hasChildren) {
          // 过滤掉已删除的子文档
          const visibleSubDocs = doc.subDocs.filter(subDoc => {
            const subDocId = subDoc.docId ? (typeof subDoc.docId === 'string' ? subDoc.docId : subDoc.docId.toString()) : '';
            return !pendingDeletes.some(d => d.type === 'doc' && d.docId === subDocId);
          });
          visibleSubDocs.forEach(subDoc => {
            childrenUl.appendChild(renderTreeNode(subDoc));
          });
        }
        
        // 渲染 blocks
        if (hasBlocks && docId) {
          const blocks = allDocsWithBlocks[docId];
          // 过滤掉已删除的 blocks
          const visibleBlocks = blocks.filter(block => {
            const blockDocId = block.docId ? (typeof block.docId === 'string' ? block.docId : block.docId.toString()) : '';
            return !pendingDeletes.some(d => d.type === 'block' && d.docId === blockDocId);
          });
          visibleBlocks.forEach(block => {
            childrenUl.appendChild(renderBlockNode(block, docId));
          });
        }
        
        childrenDiv.appendChild(childrenUl);
        li.appendChild(childrenDiv);
      }
      
      return li;
    }

    // 渲染 block 节点
    function renderBlockNode(block, parentDocId) {
      const blockDocId = block.docId ? (typeof block.docId === 'string' ? block.docId : block.docId.toString()) : '';
      const blockLi = document.createElement('li');
      blockLi.dataset.type = 'block';
      blockLi.dataset.docId = blockDocId;
      blockLi.dataset.parentDocId = parentDocId;

      const blockDiv = document.createElement('div');
      // 高亮当前 block
      const isActiveBlock = (parentDocId === currentDocId && blockDocId === currentBlockDocId);
      blockDiv.className = `doc-tree-item doc-tree-block${isActiveBlock ? ' active' : ''}`;
      blockDiv.dataset.type = 'block';
      blockDiv.dataset.docId = blockDocId;
      blockDiv.dataset.parentDocId = parentDocId;
      blockDiv.dataset.rpid = repo.rpid;
      
      // 检查是否在删除列表中
      const isDeleted = pendingDeletes.some(d => d.type === 'block' && d.docId === blockDocId);
      if (isDeleted) {
        blockDiv.style.opacity = '0.3';
        blockDiv.style.textDecoration = 'line-through';
      }

      // 在编辑模式下启用拖拽
      if (isEditMode) {
        blockDiv.draggable = true;
        blockDiv.ondragstart = handleDragStart;
        blockDiv.ondragover = handleDragOver;
        blockDiv.ondragenter = handleDragEnter;
        blockDiv.ondragleave = handleDragLeave;
        blockDiv.ondrop = handleDrop;
        blockDiv.ondragend = handleDragEnd;
        // 双击重命名
        blockDiv.ondblclick = (e) => {
          e.stopPropagation();
          const currentTitle = block.title;
          showRenameDialog('block', undefined, blockDocId, currentTitle);
        };
      }
      
      // 空白占位
      const emptyToggle = document.createElement('span');
      emptyToggle.className = 'doc-tree-toggle leaf';
      blockDiv.appendChild(emptyToggle);
      
      // Block 图标
      const blockIcon = document.createElement('span');
      blockIcon.className = 'doc-tree-icon';
      blockIcon.innerHTML = '📝';
      blockDiv.appendChild(blockIcon);
      
      // Block 标题链接
      const blockLabel = document.createElement('span');
      blockLabel.className = 'doc-tree-label';
      const blockLink = document.createElement('a');
      blockLink.href = block.url;
      // 检查是否有待更新的标题
      const pendingUpdate = pendingUpdates.find(u => u.type === 'block' && u.docId === blockDocId);
      blockLink.textContent = pendingUpdate ? pendingUpdate.title : block.title;
      blockLabel.appendChild(blockLink);
      blockDiv.appendChild(blockLabel);
      
      blockLi.appendChild(blockDiv);
      return blockLi;
    }

    // 拖拽辅助函数
    function clearDropIndicators(el) {
      if (!el) return;
      el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drag-over');
      delete el.dataset.dropPosition;
    }

    function determineDropPosition(e, target) {
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      const threshold = rect.height * 0.3;
      const type = target.dataset.type;

      if (offsetY < threshold) return 'before';
      if (offsetY > rect.height - threshold) return 'after';

      // 只有 doc/new-doc 支持放入其下
      if (type === 'doc' || type === 'new-doc') {
        return 'inside';
      }

      // block 或其他类型默认当作 after
      return 'after';
    }

    function applyDropIndicator(target, position) {
      if (!target) return;
      clearDropIndicators(target);
      if (!position) return;
      if (position === 'before') {
        target.classList.add('drop-before');
      } else if (position === 'after') {
        target.classList.add('drop-after');
      } else if (position === 'inside') {
        target.classList.add('drop-inside');
      }
      target.dataset.dropPosition = position;
    }

    function cleanupEmptyContainer(listElement) {
      if (!listElement) return;
      const isUlEmpty = listElement.children.length === 0;
      if (isUlEmpty) {
        const wrapper = listElement.parentElement;
        if (wrapper && wrapper.classList.contains('doc-tree-children')) {
          const parentLi = wrapper.parentElement;
          wrapper.remove();
          if (parentLi) {
            const toggle = parentLi.querySelector('.doc-tree-item .doc-tree-toggle');
            if (toggle) {
              toggle.classList.add('leaf');
              toggle.classList.remove('expanded');
            }
          }
        }
      }
    }

    // 拖拽事件处理
    function handleDragStart(e) {
      draggedElement = e.currentTarget;
      draggedData = {
        type: e.currentTarget.dataset.type,
        docId: e.currentTarget.dataset.docId || '',
        rpid: e.currentTarget.dataset.rpid,
        placeholderId: e.currentTarget.dataset.placeholderId
      };
      
      e.currentTarget.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', e.currentTarget.innerHTML);
    }

    function handleDragOver(e) {
      if (e.preventDefault) {
        e.preventDefault();
      }
      e.dataTransfer.dropEffect = 'move';
      const target = e.currentTarget;
      if (target !== draggedElement) {
        const allowed = ['doc', 'new-doc', 'block', 'new-block'];
        if (allowed.includes(target.dataset.type)) {
          const position = determineDropPosition(e, target);
          applyDropIndicator(target, position);
        }
      }
      return false;
    }

    function handleDragEnter(e) {
      const target = e.currentTarget;
      if (target === draggedElement) return;
      const allowed = ['doc', 'new-doc', 'block', 'new-block'];
      if (!allowed.includes(target.dataset.type)) return;
      const position = determineDropPosition(e, target);
      applyDropIndicator(target, position);
    }

    function handleDragLeave(e) {
      clearDropIndicators(e.currentTarget);
    }

    function handleDrop(e) {
      if (e.stopPropagation) {
        e.stopPropagation();
      }
      e.preventDefault();

      const target = e.currentTarget;
      const targetType = target.dataset.type;
      const dropPosition = target.dataset.dropPosition || determineDropPosition(e, target) || 'after';
      clearDropIndicators(target);

      if (draggedElement === target) {
        return false;
      }

      // 获取父 li 元素
      const draggedLi = draggedElement.closest('li');
      const targetLi = target.closest('li');
      const previousList = draggedLi?.parentElement;

      if (!draggedLi || !targetLi) {
        return false;
      }

      // 不能拖到自己的子节点下
      if (targetLi.contains(draggedLi)) {
        alert('不能将文档移动到其子文档下');
        return false;
      }

      const isTargetDocLike = targetType === 'doc' || targetType === 'new-doc';
      const isTargetBlockLike = targetType === 'block' || targetType === 'new-block';

      // 如果是新项占位符，移动到目标位置（不立即输入标题）
      if (draggedData && draggedData.placeholderId) {
        const placeholder = pendingCreates.find(p => p.id === draggedData.placeholderId);
        if (!placeholder) {
          return false;
        }

        const resolveParentFromLi = (li) => {
          const parentLi = li.parentElement?.closest('li');
          if (!parentLi) return { parentDocId: null, parentPlaceholderId: null };
          const info = parentLi.querySelector(':scope > .doc-tree-item');
          if (info?.dataset?.docId) {
            return { parentDocId: info.dataset.docId, parentPlaceholderId: null };
          }
          if (info?.dataset?.placeholderId) {
            return { parentDocId: null, parentPlaceholderId: info.dataset.placeholderId };
          }
          return { parentDocId: null, parentPlaceholderId: null };
        };

        if (dropPosition === 'inside' && isTargetDocLike) {
          const targetPlaceholderId = target.dataset.placeholderId;
          const targetDocId = target.dataset.docId;

          if (targetPlaceholderId) {
            placeholder.parentPlaceholderId = targetPlaceholderId;
            placeholder.parentDocId = null;
          } else if (targetDocId) {
            placeholder.parentDocId = targetDocId;
            placeholder.parentPlaceholderId = null;
          } else {
            placeholder.parentDocId = null;
            placeholder.parentPlaceholderId = null;
          }

          let targetChildrenDiv = targetLi.querySelector(':scope > .doc-tree-children');
          if (!targetChildrenDiv) {
            targetChildrenDiv = document.createElement('div');
            targetChildrenDiv.className = 'doc-tree-children expanded';
            const ul = document.createElement('ul');
            targetChildrenDiv.appendChild(ul);
            targetLi.appendChild(targetChildrenDiv);

            const toggle = targetLi.querySelector('.doc-tree-item .doc-tree-toggle');
            if (toggle) {
              toggle.classList.remove('leaf');
              toggle.classList.add('expanded');
            }
          }
          targetChildrenDiv.querySelector('ul')?.appendChild(draggedLi);
        } else {
          const { parentDid, parentPlaceholderId } = resolveParentFromLi(targetLi);
          placeholder.parentDid = parentDid;
          placeholder.parentPlaceholderId = parentPlaceholderId;

          if (dropPosition === 'before') {
            targetLi.parentElement?.insertBefore(draggedLi, targetLi);
          } else {
            targetLi.parentElement?.insertBefore(draggedLi, targetLi.nextSibling);
          }
        }

        cleanupEmptyContainer(previousList);
        renderTree();
        return false;
      }

      // 处理已存在的节点
      if (dropPosition === 'inside' && isTargetDocLike) {
        let targetChildrenDiv = targetLi.querySelector(':scope > .doc-tree-children');
        if (!targetChildrenDiv) {
          targetChildrenDiv = document.createElement('div');
          targetChildrenDiv.className = 'doc-tree-children expanded';
          const ul = document.createElement('ul');
          targetChildrenDiv.appendChild(ul);
          targetLi.appendChild(targetChildrenDiv);

          const toggle = targetLi.querySelector('.doc-tree-item .doc-tree-toggle');
          if (toggle) {
            toggle.classList.remove('leaf');
            toggle.classList.add('expanded');
          }
        }

        const targetUl = targetChildrenDiv.querySelector('ul');
        if (targetUl) {
          targetUl.appendChild(draggedLi);
        }
      } else {
        const list = targetLi.parentElement;
        if (!list) return false;
        if (dropPosition === 'before') {
          list.insertBefore(draggedLi, targetLi);
        } else {
          list.insertBefore(draggedLi, targetLi.nextSibling);
        }

        // 如果目标是 block/new-block，确保仍位于父 doc 的 children 容器内
        if (isTargetBlockLike) {
          const parentLi = list.closest('li');
          if (parentLi) {
            const parentToggle = parentLi.querySelector('.doc-tree-item .doc-tree-toggle');
            if (parentToggle) {
              parentToggle.classList.remove('leaf');
            }
          }
        }
      }

      cleanupEmptyContainer(previousList);
      return false;
    }

    function handleDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      
      // 清除所有 drag-over 样式
      document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
      });
      document.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(el => {
        clearDropIndicators(el);
      });

      draggedElement = null;
      draggedData = null;
    }

    // 显示父文档标题输入对话框（当父文档是占位符且没有标题时）
    function showParentTitleInputDialog(parentPlaceholderId, childPlaceholderId, childType, draggedLi, targetLi) {
      const dialog = document.createElement('div');
      dialog.className = 'title-input-dialog';
      dialog.innerHTML = `
        <h3>首先输入父文档标题</h3>
        <input type="text" id="parent-title-input" placeholder="请输入父文档标题..." autofocus>
        <div class="title-input-dialog-buttons">
          <button onclick="this.closest('.title-input-dialog').remove()">取消</button>
          <button class="primary" onclick="window.__confirmParentTitleInput && window.__confirmParentTitleInput()">确定</button>
        </div>
      `;
      document.body.appendChild(dialog);

      const input = dialog.querySelector('#parent-title-input');
      
      window.__confirmParentTitleInput = () => {
        const parentTitle = input.value.trim();
        if (!parentTitle) {
          alert('请输入父文档标题');
          return;
        }

        // 更新父文档占位符
        const parentPlaceholder = pendingCreates.find(p => p.id === parentPlaceholderId);
        if (parentPlaceholder) {
          parentPlaceholder.title = parentTitle;
          
          // 更新父文档显示
          const parentDiv = targetLi.querySelector('.doc-tree-item');
          const parentLabel = parentDiv.querySelector('.doc-tree-label');
          parentLabel.textContent = parentTitle;
          parentLabel.style.color = '#333';
        }

        dialog.remove();
        delete window.__confirmParentTitleInput;

        // 现在输入子项标题
        showTitleInputDialog(childPlaceholderId, childType, parentPlaceholderId, draggedLi, targetLi);
      };

      input.focus();
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.__confirmParentTitleInput();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          dialog.remove();
          delete window.__confirmParentTitleInput;
        }
      };
    }

    // 显示重命名对话框（用于现有文档和块）
    function showRenameDialog(type, docId, blockDocId, currentTitle) {
      const dialog = document.createElement('div');
      dialog.className = 'title-input-dialog';
      dialog.innerHTML = `
        <h3>重命名 ${type === 'doc' ? 'Doc' : 'Block'}</h3>
        <input type="text" id="rename-input" value="${currentTitle || ''}" placeholder="请输入新标题..." autofocus>
        <div class="title-input-dialog-buttons">
          <button onclick="this.closest('.title-input-dialog').remove()">取消</button>
          <button class="primary" onclick="window.__confirmRename && window.__confirmRename()">确定</button>
        </div>
      `;
      document.body.appendChild(dialog);

      const input = dialog.querySelector('#rename-input');
      input.select(); // 选中现有文本
      
      // 确定按钮处理
      window.__confirmRename = () => {
        const newTitle = input.value.trim();
        if (!newTitle) {
          alert('请输入标题');
          return;
        }

        if (newTitle === currentTitle) {
          // 标题没有变化，直接关闭
          dialog.remove();
          delete window.__confirmRename;
          return;
        }

        // 添加到待更新列表
        const updateItem = {
          type: type,
          title: newTitle,
          docId: type === 'doc' ? docId : blockDocId
        };

        // 检查是否已存在，如果存在则更新，否则添加
        const existingIndex = pendingUpdates.findIndex(u => 
          u.type === type && u.docId === updateItem.docId
        );
        
        if (existingIndex >= 0) {
          pendingUpdates[existingIndex] = updateItem;
        } else {
          pendingUpdates.push(updateItem);
        }

        // 立即更新显示
        const targetDocId = type === 'doc' ? docId : blockDocId;
        const itemDiv = document.querySelector(
          `.doc-tree-item[data-type="${type}"][data-doc-id="${targetDocId}"]`
        );
        if (itemDiv) {
          const label = itemDiv.querySelector('.doc-tree-label');
          if (label) {
            const link = label.querySelector('a');
            if (link) {
              link.textContent = newTitle;
            } else {
              label.textContent = newTitle;
            }
          }
        }

        dialog.remove();
        delete window.__confirmRename;
      };

      input.focus();
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.__confirmRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          dialog.remove();
          delete window.__confirmRename;
        }
      };
    }

    // 显示标题输入对话框
    function showTitleInputDialog(placeholderId, type, parentDocId, draggedLi, targetLi) {
      const dialog = document.createElement('div');
      dialog.className = 'title-input-dialog';
      dialog.innerHTML = `
        <h3>输入 ${type === 'doc' ? 'Doc' : 'Block'} 标题</h3>
        <input type="text" id="title-input" placeholder="请输入标题..." autofocus>
        <div class="title-input-dialog-buttons">
          <button onclick="this.closest('.title-input-dialog').remove()">取消</button>
          <button class="primary" onclick="window.__confirmTitleInput && window.__confirmTitleInput()">确定</button>
        </div>
      `;
      document.body.appendChild(dialog);

      const input = dialog.querySelector('#title-input');
      
      // 确定按钮处理
      window.__confirmTitleInput = () => {
        const title = input.value.trim();
        if (!title) {
          alert('请输入标题');
          return;
        }

        // 更新占位符
        const placeholder = pendingCreates.find(p => p.id === placeholderId);
        if (placeholder) {
          placeholder.title = title;
          // 如果 parentDocId 是字符串（placeholderId），保留它，否则使用 docId
          placeholder.parentDocId = typeof parentDocId === 'string' ? parentDocId : parentDocId;
          placeholder.parentPlaceholderId = typeof parentDocId === 'string' ? parentDocId : null;
        }

        // 重新渲染树，更新显示
        renderTree();
        
        dialog.remove();
        delete window.__confirmTitleInput;
      };

      input.focus();
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.__confirmTitleInput();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          dialog.remove();
          delete window.__confirmTitleInput;
        }
      };
    }

    // 渲染占位符节点
    function renderPlaceholderNode(placeholder) {
      const li = document.createElement('li');
      
      const placeholderDiv = document.createElement('div');
      placeholderDiv.className = 'doc-tree-item new-item';
      placeholderDiv.dataset.type = `new-${placeholder.type}`;
      placeholderDiv.dataset.placeholderId = placeholder.id;
      placeholderDiv.draggable = true;
      
      const icon = document.createElement('span');
      icon.className = 'doc-tree-icon';
      icon.innerHTML = placeholder.type === 'doc' ? '📁' : '📝';
      placeholderDiv.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'doc-tree-label';
      label.textContent = placeholder.title || `[新建 ${placeholder.type === 'doc' ? 'Doc' : 'Block'}]`;
      label.style.color = placeholder.title ? '#333' : '#2196F3';
      label.style.fontWeight = placeholder.title ? '500' : '500';
      label.style.fontSize = '14px';
      placeholderDiv.appendChild(label);

      // 双击事件：输入标题
      placeholderDiv.ondblclick = (e) => {
        e.stopPropagation();
        const placeholderId = placeholderDiv.dataset.placeholderId;
        const placeholder = pendingCreates.find(p => p.id === placeholderId);
        if (!placeholder) return;
        
        // 确定父节点信息
        let parentDocId = null;
        if (placeholder.parentPlaceholderId) {
          parentDocId = placeholder.parentPlaceholderId;
        } else {
          parentDocId = placeholder.parentDocId;
        }
        
        const type = placeholderDiv.dataset.type.replace('new-', '');
        const li = placeholderDiv.closest('li');
        showTitleInputDialog(placeholderId, type, parentDocId, li, null);
      };

      // 拖拽事件
      placeholderDiv.ondragstart = handleDragStart;
      placeholderDiv.ondragover = handleDragOver;
      placeholderDiv.ondragenter = handleDragEnter;
      placeholderDiv.ondragleave = handleDragLeave;
      placeholderDiv.ondrop = handleDrop;
      placeholderDiv.ondragend = handleDragEnd;

      li.appendChild(placeholderDiv);
      return li;
    }

    // 在指定位置插入占位符
    function insertPlaceholderInTree(parentLi, placeholder, index) {
      let targetChildrenDiv = parentLi.querySelector(':scope > .doc-tree-children');
      if (!targetChildrenDiv) {
        targetChildrenDiv = document.createElement('div');
        targetChildrenDiv.className = 'doc-tree-children expanded';
        const ul = document.createElement('ul');
        targetChildrenDiv.appendChild(ul);
        parentLi.appendChild(targetChildrenDiv);

        const toggle = parentLi.querySelector('.doc-tree-item .doc-tree-toggle');
        if (toggle) {
          toggle.classList.remove('leaf');
          toggle.classList.add('expanded');
        }
      }

      const targetUl = targetChildrenDiv.querySelector('ul');
      if (targetUl) {
        const placeholderLi = renderPlaceholderNode(placeholder);
        const children = Array.from(targetUl.children);
        if (index >= 0 && index < children.length) {
          targetUl.insertBefore(placeholderLi, children[index]);
        } else {
          targetUl.appendChild(placeholderLi);
        }
      }
    }

    // 渲染整个树
    function renderTree() {
      const treeContainer = document.getElementById('doc-tree');
      if (!treeContainer) return;

      treeContainer.innerHTML = '';
      treeContainer.className = 'doc-tree';
      const rootUl = document.createElement('ul');
      
      const rpid = repo.rpid;
      const docs = treeData[rpid] || [];
      
      // 渲染已存在的 docs（过滤掉已删除的）
      docs.forEach(doc => {
        const docId = doc.docId ? (typeof doc.docId === 'string' ? doc.docId : doc.docId.toString()) : (doc.did ? doc.did.toString() : '');
        const isDeleted = pendingDeletes.some(d => 
          d.type === 'doc' && 
          (d.docId === docId || (d.did && d.did.toString() === docId) || (doc.did && d.did === doc.did))
        );
        if (!isDeleted) {
          rootUl.appendChild(renderTreeNode(doc, true));
        }
      });
      
      // 渲染根层级的占位符
      const rootPlaceholders = pendingCreates.filter(p => !p.parentDid && !p.parentPlaceholderId);
      rootPlaceholders.forEach((placeholder, index) => {
        const placeholderLi = renderPlaceholderNode(placeholder);
        const children = Array.from(rootUl.children);
        if (index < children.length) {
          rootUl.insertBefore(placeholderLi, children[index]);
        } else {
          rootUl.appendChild(placeholderLi);
        }
      });
      
      treeContainer.appendChild(rootUl);

      // 在所有 doc 节点下插入占位符
      function insertPlaceholdersRecursive(liElement, parentDocId, parentPlaceholderId) {
        const placeholders = pendingCreates.filter(p => {
          if (parentPlaceholderId) {
            return p.parentPlaceholderId === parentPlaceholderId;
          } else if (parentDocId) {
            return p.parentDocId === parentDocId && !p.parentPlaceholderId;
          } else {
            return false;
          }
        });

        if (placeholders.length > 0) {
          placeholders.forEach((placeholder, index) => {
            insertPlaceholderInTree(liElement, placeholder, index);
          });
        }

        // 递归处理子节点
        const childrenUl = liElement.querySelector(':scope > .doc-tree-children > ul');
        if (childrenUl) {
          Array.from(childrenUl.children).forEach(childLi => {
            const itemDiv = childLi.querySelector('.doc-tree-item');
            if (itemDiv) {
              if (itemDiv.dataset.type === 'doc') {
                const docId = itemDiv.dataset.docId || '';
                insertPlaceholdersRecursive(childLi, docId, null);
              } else if (itemDiv.dataset.type === 'new-doc') {
                const placeholderId = itemDiv.dataset.placeholderId;
                insertPlaceholdersRecursive(childLi, null, placeholderId);
              }
            }
          });
        }
      }

      // 在根层级节点下插入占位符
      Array.from(rootUl.children).forEach(li => {
        const itemDiv = li.querySelector('.doc-tree-item');
        if (itemDiv) {
          if (itemDiv.dataset.type === 'doc') {
            const docId = itemDiv.dataset.docId || '';
            insertPlaceholdersRecursive(li, docId, null);
          } else if (itemDiv.dataset.type === 'new-doc') {
            const placeholderId = itemDiv.dataset.placeholderId;
            insertPlaceholdersRecursive(li, null, placeholderId);
          }
        }
      });

      // 自动展开包含当前 doc/block 的节点
      if (currentDocId || currentBlockDocId) {
        expandToActive(treeContainer);
      }
    }

    // 展开到当前活动节点
    function expandToActive(container) {
      const activeItem = container.querySelector('.doc-tree-item.active');
      if (activeItem) {
        let parent = activeItem.parentElement;
        while (parent && parent !== container) {
          if (parent.classList.contains('doc-tree-children')) {
            parent.classList.add('expanded');
            const toggle = parent.previousElementSibling?.querySelector('.doc-tree-toggle');
            if (toggle) {
              toggle.classList.add('expanded');
            }
          }
          parent = parent.parentElement;
        }
      }
    }

    // 初始化
    const existingControls = document.getElementById('tree-edit-controls');
    if (!existingControls) {
      const controls = renderEditControls();
      container.insertBefore(controls, container.firstChild);
    }

    renderTree();
    
    // Push 和 Pull 操作处理（仅在 repo_detail 页面）
    if (window.location.pathname.includes('/base/repo/')) {
      // Push 表单处理
      const pushForm = document.getElementById('push-form');
      if (pushForm) {
        pushForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          const button = pushForm.querySelector('button[type="submit"]');
          const originalText = button.textContent;
          
          // 禁用按钮并显示加载状态
          button.disabled = true;
          button.textContent = '推送中...';
          await Notification.info('正在推送到 GitHub...');
          
          try {
            const formData = new FormData(pushForm);
            const response = await fetch(pushForm.action, {
              method: 'POST',
              body: formData,
            });
            
            if (response.ok) {
              await Notification.success('成功推送到 GitHub');
              // 延迟刷新页面，让用户看到成功消息
              setTimeout(() => {
                window.location.reload();
              }, 1000);
            } else {
              const data = await response.json().catch(() => ({}));
              await Notification.error(data.error || '推送到 GitHub 失败');
              button.disabled = false;
              button.textContent = originalText;
            }
          } catch (error) {
            await Notification.error('推送到 GitHub 失败: ' + error.message);
            button.disabled = false;
            button.textContent = originalText;
          }
        });
      }
      
      // Pull 表单处理
      const pullForm = document.getElementById('pull-form');
      if (pullForm) {
        pullForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          const button = pullForm.querySelector('button[type="submit"]');
          const originalText = button.textContent;
          
          // 禁用按钮并显示加载状态
          button.disabled = true;
          button.textContent = '拉取中...';
          await Notification.info('正在从 GitHub 拉取...');
          
          try {
            const formData = new FormData(pullForm);
            const response = await fetch(pullForm.action, {
              method: 'POST',
              body: formData,
            });
            
            if (response.ok) {
              await Notification.success('成功从 GitHub 拉取');
              // 延迟刷新页面，让用户看到成功消息
              setTimeout(() => {
                window.location.reload();
              }, 1000);
            } else {
              const data = await response.json().catch(() => ({}));
              await Notification.error(data.error || '从 GitHub 拉取失败');
              button.disabled = false;
              button.textContent = originalText;
            }
          } catch (error) {
            await Notification.error('从 GitHub 拉取失败: ' + error.message);
            button.disabled = false;
            button.textContent = originalText;
          }
        });
      }
    }

    // 搜索功能
    function loadQuery() {
      const q = $('[name="q"]').val().toString();
      const branch = $('[name="branch"]').val().toString();
      const url = new URL(window.location.href);
      if (!q) {
        url.searchParams.delete('q');
      } else {
        url.searchParams.set('q', q);
      }
      if (branch) {
        url.searchParams.set('branch', branch);
      }
      url.searchParams.delete('page');
      pjax.request({ url: url.toString() });
    }

    function inputChanged() {
      loadQuery();
    }

    $('#searchForm').on('submit', (ev) => {
      ev.preventDefault();
      inputChanged();
    });

    $('#searchForm').find('input[name="q"]').on('input', _.debounce(inputChanged, 500));
    
    // 当搜索框获得焦点时显示搜索结果容器
    $('#searchForm').find('input[name="q"]').on('focus', () => {
      const $input = $('#searchForm').find('input[name="q"]');
      const $results = $('#repo-search-results');
      if ($input.val() && $input.val().trim()) {
        $results.show();
      }
    });
    
    // 点击外部区域关闭搜索结果
    $(document).on('click', (ev) => {
      const $target = $(ev.target);
      if (!$target.closest('#searchForm').length && !$target.closest('#repo-search-results').length) {
        const $results = $('#repo-search-results');
        if ($results.is(':visible')) {
          const $input = $('[name="q"]');
          if (!$input.val() || !$input.val().trim()) {
            $results.hide();
          }
        }
      }
    });
    
    // pjax 更新后，如果有搜索关键词，显示搜索结果
    $(document).on('vjContentNew', () => {
      const $input = $('#searchForm').find('input[name="q"]');
      const $results = $('#repo-search-results');
      if ($input.val() && $input.val().trim()) {
        $results.show();
      }
    });

    // 分页
    $(document).on('click', 'a.pager__item', (ev) => {
      ev.preventDefault();
      pjax.request(ev.currentTarget.getAttribute('href')).then(() => window.scrollTo(0, 0));
    });
    
    // 同步本地文件功能
    if (typeof window.syncLocalFiles !== 'function') {
      window.syncLocalFiles = async function() {
        const btn = document.getElementById('sync-local-btn');
        const progressDiv = document.getElementById('sync-progress');
        const statusDiv = document.getElementById('sync-status');
        const progressBar = document.getElementById('sync-progress-bar');
        const messageDiv = document.getElementById('sync-message');
        
        if (!btn || !progressDiv || !statusDiv || !progressBar || !messageDiv) {
          return;
        }
        
        // 禁用按钮
        btn.disabled = true;
        btn.textContent = '同步中...';
        
        // 显示进度条
        progressDiv.style.display = 'block';
        statusDiv.textContent = '正在启动同步...';
        progressBar.style.width = '0%';
        messageDiv.textContent = '';
        
        try {
          // 获取当前分支
          const branchSelect = document.getElementById('branch-select');
          const currentBranch = branchSelect ? branchSelect.value : 'main';
          
          // 启动同步任务
          const syncUrl = `/d/${repo.domainId}/base/repo/${repo.rpid}/branch/${currentBranch}/sync-local`;
          const response = await fetch(syncUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
          });
          
          if (!response.ok) {
            throw new Error('启动同步失败');
          }
          
          const { taskId } = await response.json();
          
          // 轮询获取进度
          const pollInterval = setInterval(async () => {
            try {
              const statusResponse = await fetch(syncUrl);
              if (!statusResponse.ok) {
                throw new Error('获取进度失败');
              }
              
              const status = await statusResponse.json();
              
              if (status.status === 'not_started') {
                return; // 任务还未开始
              }
              
              // 更新进度
              const progress = status.progress || 0;
              const total = status.total || 100;
              const percent = Math.round((progress / total) * 100);
              
              progressBar.style.width = `${percent}%`;
              statusDiv.textContent = status.current || '处理中...';
              messageDiv.textContent = status.current || '';
              
              // 检查是否完成
              if (status.status === 'completed') {
                clearInterval(pollInterval);
                statusDiv.textContent = '✓ 同步完成';
                // 使用后端返回的实际消息
                messageDiv.textContent = status.current || '同步完成';
                progressBar.style.backgroundColor = '#28a745';
                
                // 3秒后刷新页面
                setTimeout(() => {
                  window.location.reload();
                }, 3000);
              } else if (status.status === 'error') {
                clearInterval(pollInterval);
                statusDiv.textContent = '✗ 同步失败';
                messageDiv.textContent = status.error || '未知错误';
                progressBar.style.backgroundColor = '#dc3545';
                btn.disabled = false;
                btn.textContent = '同步本地文件';
              }
            } catch (err) {
              console.error('获取进度失败:', err);
            }
          }, 500); // 每500ms轮询一次
          
          // 30秒后超时
          setTimeout(() => {
            clearInterval(pollInterval);
            if (progressBar.style.width !== '100%') {
              statusDiv.textContent = '⚠ 同步超时';
              messageDiv.textContent = '同步操作可能仍在进行中，请稍后刷新页面查看结果';
              btn.disabled = false;
              btn.textContent = '同步本地文件';
            }
          }, 30000);
          
        } catch (error) {
          statusDiv.textContent = '✗ 启动失败';
          messageDiv.textContent = error.message || '未知错误';
          progressBar.style.backgroundColor = '#dc3545';
          btn.disabled = false;
          btn.textContent = '同步本地文件';
        }
      };
    }
});

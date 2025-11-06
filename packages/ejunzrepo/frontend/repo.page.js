import $ from 'jquery';
import {
  AutoloadPage,
  addPage
} from '@ejunz/ui-default';

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

addPage(new AutoloadPage('repo_detail,repo_map,doc_detail,block_detail', async () => {
    // 注入样式
    if (!document.getElementById('doc-tree-styles')) {
      const styleEl = document.createElement('div');
      styleEl.id = 'doc-tree-styles';
      styleEl.innerHTML = treeStyles;
      document.head.appendChild(styleEl.firstElementChild);
    }

    const treeData = UiContext.docHierarchy;
    const repo = UiContext.repo;
    const currentDid = UiContext.ddoc?.did;
    const currentBid = UiContext.block?.bid;
    
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
      };

      controlsDiv.appendChild(editBtn);
      controlsDiv.appendChild(saveBtn);
      controlsDiv.appendChild(cancelBtn);
      controlsDiv.appendChild(newDocBtn);
      controlsDiv.appendChild(newBlockBtn);

      return controlsDiv;
    }

    // 创建新项占位符
    function createNewItemPlaceholder(type) {
      const placeholderId = `new-${type}-${Date.now()}`;
      const placeholder = {
        id: placeholderId,
        type: type,
        title: '',
        parentDid: null,
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
        let parentDid = null;
        if (placeholder.parentPlaceholderId) {
          parentDid = placeholder.parentPlaceholderId;
        } else {
          parentDid = placeholder.parentDid;
        }
        
        const type = placeholderDiv.dataset.type.replace('new-', '');
        const li = placeholderDiv.closest('li');
        showTitleInputDialog(placeholderId, type, parentDid, li, null);
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
      const structure = collectStructure();
      const creates = collectPendingCreates(structure);
      
      console.log('Sending structure to server:', JSON.stringify({ structure, creates }, null, 2));
      
      try {
        const response = await fetch(`/d/${repo.domainId}/base/repo/${repo.rpid}/update_structure`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ structure, creates }),
        });

        if (response.ok) {
          alert('保存成功！');
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
      console.log('collectStructure v3 - bid is unique per repo');

      const rootUl = container.querySelector('.doc-tree > ul');
      if (!rootUl) return structure;

      const docItems = Array.from(rootUl.children).filter(li => {
        const item = li.querySelector('.doc-tree-item');
        return item && item.dataset.type === 'doc';
      });

      docItems.forEach((li, index) => {
        const itemDiv = li.querySelector('.doc-tree-item');
        const did = parseInt(itemDiv.dataset.did);
        const docStructure = {
          did: did,
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
            parentDid: null, // 根层级
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
            console.log(`Found ${subDoc.pendingCreates.length} pendingCreates under placeholder doc ${placeholderId}:`, subDoc.pendingCreates);
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
                  let actualParentDid = null;
                  let actualParentPlaceholderId = null;
                  
                  if (placeholder.parentPlaceholderId) {
                    actualParentPlaceholderId = placeholder.parentPlaceholderId;
                  } else if (placeholder.parentDid) {
                    actualParentDid = placeholder.parentDid;
                  } else {
                    // 从当前结构获取
                    if (structure.did) {
                      actualParentDid = structure.did;
                    } else if (structure.placeholderId) {
                      actualParentPlaceholderId = structure.placeholderId;
                    }
                  }
                  
                  structure.pendingCreates.push({
                    type: placeholder.type,
                    title: placeholder.title,
                    parentDid: actualParentDid,
                    parentPlaceholderId: actualParentPlaceholderId,
                    placeholderId: placeholder.id,
                    order: subDoc.order
                  });
                  console.log(`Added placeholder doc ${placeholder.title} to pendingCreates, parentDid=${actualParentDid}, parentPlaceholderId=${actualParentPlaceholderId}`);
                }
              }
            }
            
            // 收集子 doc 的 pendingCreates（包括占位符 doc 下的 block）
            if (subDoc.pendingCreates && subDoc.pendingCreates.length > 0) {
              console.log(`Collecting ${subDoc.pendingCreates.length} pendingCreates from nested doc/placeholder:`, subDoc.pendingCreates);
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
      
      console.log(`Final structure.pendingCreates count: ${structure.pendingCreates ? structure.pendingCreates.length : 0}`);
      
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
        const type = itemDiv.dataset.type;

        if (type === 'doc') {
          const did = parseInt(itemDiv.dataset.did);
          const subDoc = {
            did: did,
            order: index,
            subDocs: []
          };
          collectChildren(childLi, subDoc);
          parentStructure.subDocs.push(subDoc);
        } else if (type === 'block') {
          const bid = parseInt(itemDiv.dataset.bid);
          if (!parentStructure.blocks) {
            parentStructure.blocks = [];
          }
          const blockData = {
            bid: bid,  // bid 在整个 repo 内唯一，不需要 did
            order: index
          };
          console.log('Collecting block:', blockData);
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
              if (parentStructure.did) {
                actualParentDid = parentStructure.did;
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
              console.log(`Block ${placeholder.title}: Using placeholder.parentPlaceholderId=${actualParentPlaceholderId}`);
            } else if (placeholder.parentDid) {
              // 父节点是已存在的 doc
              actualParentDid = placeholder.parentDid;
              console.log(`Block ${placeholder.title}: Using placeholder.parentDid=${actualParentDid}`);
            } else {
              // 没有明确记录父节点，尝试从 parentStructure 获取
              if (parentStructure.did) {
                // parentStructure 是已存在的 doc
                actualParentDid = parentStructure.did;
                console.log(`Block ${placeholder.title}: Using parentStructure.did=${actualParentDid}`);
              } else if (parentStructure.placeholderId) {
                // parentStructure 是占位符 doc
                actualParentPlaceholderId = parentStructure.placeholderId;
                console.log(`Block ${placeholder.title}: Using parentStructure.placeholderId=${actualParentPlaceholderId}`);
              } else {
                console.warn(`Block ${placeholder.title}: Cannot determine parent, parentStructure=`, parentStructure);
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
            console.log(`Collecting placeholder block: ${placeholder.title}, parentDid=${actualParentDid}, parentPlaceholderId=${actualParentPlaceholderId}, parentStructure.did=${parentStructure.did}, parentStructure.placeholderId=${parentStructure.placeholderId}`);
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
            console.log(`Collecting placeholder block: ${placeholder.title}, parentDid=${actualParentDid}, parentPlaceholderId=${actualParentPlaceholderId}, parentStructure.did=${parentStructure.did}, parentStructure.placeholderId=${parentStructure.placeholderId}`);
          }
        }
      });
    }

    // 渲染树节点
    function renderTreeNode(doc, isRoot = false) {
      const hasChildren = doc.subDocs && doc.subDocs.length > 0;
      const hasBlocks = allDocsWithBlocks[doc.did] && allDocsWithBlocks[doc.did].length > 0;
      const isActiveDoc = doc.did === currentDid;
      
      const li = document.createElement('li');
      li.dataset.type = 'doc';
      li.dataset.did = doc.did;
      
      // 文档节点
      const itemDiv = document.createElement('div');
      itemDiv.className = `doc-tree-item${isActiveDoc ? ' active' : ''}`;
      itemDiv.dataset.type = 'doc';
      itemDiv.dataset.did = doc.did;
      itemDiv.dataset.rpid = repo.rpid;

      // 在编辑模式下启用拖拽
      if (isEditMode) {
        itemDiv.draggable = true;
        itemDiv.ondragstart = handleDragStart;
        itemDiv.ondragover = handleDragOver;
        itemDiv.ondragenter = handleDragEnter;
        itemDiv.ondragleave = handleDragLeave;
        itemDiv.ondrop = handleDrop;
        itemDiv.ondragend = handleDragEnd;
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
      link.textContent = doc.title;
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
        
        // 渲染子文档
        if (hasChildren) {
          doc.subDocs.forEach(subDoc => {
            childrenUl.appendChild(renderTreeNode(subDoc));
          });
        }
        
        // 渲染 blocks
        if (hasBlocks) {
          const blocks = allDocsWithBlocks[doc.did];
          blocks.forEach(block => {
            childrenUl.appendChild(renderBlockNode(block, doc.did));
          });
        }
        
        childrenDiv.appendChild(childrenUl);
        li.appendChild(childrenDiv);
      }
      
      return li;
    }

    // 渲染 block 节点
    function renderBlockNode(block, parentDid) {
      const blockLi = document.createElement('li');
      blockLi.dataset.type = 'block';
      blockLi.dataset.bid = block.bid;
      blockLi.dataset.did = parentDid;

      const blockDiv = document.createElement('div');
      // 高亮当前 block
      const isActiveBlock = (parentDid === currentDid && block.bid === currentBid);
      blockDiv.className = `doc-tree-item doc-tree-block${isActiveBlock ? ' active' : ''}`;
      blockDiv.dataset.type = 'block';
      blockDiv.dataset.bid = block.bid;
      blockDiv.dataset.did = parentDid;
      blockDiv.dataset.rpid = repo.rpid;

      // 在编辑模式下启用拖拽
      if (isEditMode) {
        blockDiv.draggable = true;
        blockDiv.ondragstart = handleDragStart;
        blockDiv.ondragover = handleDragOver;
        blockDiv.ondragenter = handleDragEnter;
        blockDiv.ondragleave = handleDragLeave;
        blockDiv.ondrop = handleDrop;
        blockDiv.ondragend = handleDragEnd;
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
      blockLink.textContent = block.title;
      blockLabel.appendChild(blockLink);
      blockDiv.appendChild(blockLabel);
      
      blockLi.appendChild(blockDiv);
      return blockLi;
    }

    // 拖拽事件处理
    function handleDragStart(e) {
      draggedElement = e.currentTarget;
      draggedData = {
        type: e.currentTarget.dataset.type,
        did: e.currentTarget.dataset.did,
        bid: e.currentTarget.dataset.bid,
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
      return false;
    }

    function handleDragEnter(e) {
      const target = e.currentTarget;
      if (target !== draggedElement && (target.dataset.type === 'doc' || target.dataset.type === 'new-doc')) {
        target.classList.add('drag-over');
      }
    }

    function handleDragLeave(e) {
      e.currentTarget.classList.remove('drag-over');
    }

    function handleDrop(e) {
      if (e.stopPropagation) {
        e.stopPropagation();
      }
      e.preventDefault();

      const target = e.currentTarget;
      target.classList.remove('drag-over');

      if (draggedElement === target) {
        return false;
      }

      // 只允许拖到 doc 下面（包括占位符 doc）
      const isDoc = target.dataset.type === 'doc' || target.dataset.type === 'new-doc';
      if (!isDoc) {
        return false;
      }

      // 获取父 li 元素
      const draggedLi = draggedElement.closest('li');
      const targetLi = target.closest('li');

      if (!draggedLi || !targetLi) {
        return false;
      }

      // 不能拖到自己的子节点下
      if (targetLi.contains(draggedLi)) {
        alert('不能将文档移动到其子文档下');
        return false;
      }

      // 如果是新项占位符，移动到目标位置（不立即输入标题）
      if (draggedData && draggedData.placeholderId) {
        // 如果目标是占位符 doc，需要先获取它的 placeholderId
        const targetPlaceholderId = target.dataset.placeholderId;
        let parentDid = null;
        
        if (target.dataset.type === 'new-doc' && targetPlaceholderId) {
          // 目标是占位符 doc，使用 placeholderId 作为临时标识
          parentDid = targetPlaceholderId; // 字符串，会被识别为 parentPlaceholderId
        } else {
          const targetDid = target.dataset.did;
          if (targetDid) {
            parentDid = parseInt(targetDid);
          } else {
            // 如果 did 不存在，可能是占位符 doc 但没有 placeholderId
            console.warn('Target doc has no did or placeholderId');
            return false;
          }
        }
        
        // 更新占位符的父节点信息
        const placeholder = pendingCreates.find(p => p.id === draggedData.placeholderId);
        if (placeholder) {
          if (typeof parentDid === 'string') {
            placeholder.parentPlaceholderId = parentDid;
            placeholder.parentDid = null;
          } else {
            placeholder.parentDid = parentDid;
            placeholder.parentPlaceholderId = null;
          }
          console.log(`Updated placeholder ${placeholder.id} parent: parentDid=${placeholder.parentDid}, parentPlaceholderId=${placeholder.parentPlaceholderId}`);
        }

        // 移动节点到目标位置
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

        // 重新渲染树，确保占位符显示在正确位置
        renderTree();
        return false;
      }

      // 移动节点
      let targetChildrenDiv = targetLi.querySelector(':scope > .doc-tree-children');
      if (!targetChildrenDiv) {
        // 创建 children 容器
        targetChildrenDiv = document.createElement('div');
        targetChildrenDiv.className = 'doc-tree-children expanded';
        const ul = document.createElement('ul');
        targetChildrenDiv.appendChild(ul);
        targetLi.appendChild(targetChildrenDiv);

        // 更新 toggle 按钮
        const toggle = target.querySelector('.doc-tree-toggle');
        if (toggle) {
          toggle.classList.remove('leaf');
          toggle.classList.add('expanded');
        }
      }

      const targetUl = targetChildrenDiv.querySelector('ul');
      if (targetUl) {
        targetUl.appendChild(draggedLi);
      }

      return false;
    }

    function handleDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      
      // 清除所有 drag-over 样式
      document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
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

    // 显示标题输入对话框
    function showTitleInputDialog(placeholderId, type, parentDid, draggedLi, targetLi) {
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
          // 如果 parentDid 是字符串（placeholderId），保留它，否则使用数字
          placeholder.parentDid = typeof parentDid === 'string' ? parentDid : parentDid;
          placeholder.parentPlaceholderId = typeof parentDid === 'string' ? parentDid : null;
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
        let parentDid = null;
        if (placeholder.parentPlaceholderId) {
          parentDid = placeholder.parentPlaceholderId;
        } else {
          parentDid = placeholder.parentDid;
        }
        
        const type = placeholderDiv.dataset.type.replace('new-', '');
        const li = placeholderDiv.closest('li');
        showTitleInputDialog(placeholderId, type, parentDid, li, null);
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
      
      // 渲染已存在的 docs
      docs.forEach(doc => {
        rootUl.appendChild(renderTreeNode(doc, true));
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
      function insertPlaceholdersRecursive(liElement, parentDid, parentPlaceholderId) {
        const placeholders = pendingCreates.filter(p => {
          if (parentPlaceholderId) {
            return p.parentPlaceholderId === parentPlaceholderId;
          } else if (parentDid) {
            return p.parentDid === parentDid && !p.parentPlaceholderId;
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
                const did = parseInt(itemDiv.dataset.did);
                insertPlaceholdersRecursive(childLi, did, null);
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
            const did = parseInt(itemDiv.dataset.did);
            insertPlaceholdersRecursive(li, did, null);
          } else if (itemDiv.dataset.type === 'new-doc') {
            const placeholderId = itemDiv.dataset.placeholderId;
            insertPlaceholdersRecursive(li, null, placeholderId);
          }
        }
      });

      // 自动展开包含当前 doc/block 的节点
      if (currentDid || currentBid) {
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
}));

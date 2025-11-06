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
}
.doc-tree-label a:hover {
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

    const container = document.getElementById('doc-tree');
    if (!container) return;

    // 从后端数据中获取所有 docs 的 blocks
    const allDocsWithBlocks = UiContext.allDocsWithBlocks || {};

    // 渲染树节点
    function renderTreeNode(doc, isRoot = false) {
      const hasChildren = doc.subDocs && doc.subDocs.length > 0;
      const hasBlocks = allDocsWithBlocks[doc.did] && allDocsWithBlocks[doc.did].length > 0;
      const isActiveDoc = doc.did === currentDid;
      
      const li = document.createElement('li');
      
      // 文档节点
      const itemDiv = document.createElement('div');
      itemDiv.className = `doc-tree-item${isActiveDoc ? ' active' : ''}`;
      
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
      link.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) {
          return; // 允许在新标签页打开
        }
      };
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
            const blockLi = document.createElement('li');
            const blockDiv = document.createElement('div');
            // 高亮当前 block
            const isActiveBlock = (doc.did === currentDid && block.bid === currentBid);
            blockDiv.className = `doc-tree-item doc-tree-block${isActiveBlock ? ' active' : ''}`;
            
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
            childrenUl.appendChild(blockLi);
          });
        }
        
        childrenDiv.appendChild(childrenUl);
        li.appendChild(childrenDiv);
      }
      
      return li;
    }

    // 渲染整个树
    container.innerHTML = '';
    container.className = 'doc-tree';
    const rootUl = document.createElement('ul');
    
    const rpid = repo.rpid;
    const docs = treeData[rpid] || [];
    
    docs.forEach(doc => {
      rootUl.appendChild(renderTreeNode(doc, true));
    });
    
    container.appendChild(rootUl);
}));

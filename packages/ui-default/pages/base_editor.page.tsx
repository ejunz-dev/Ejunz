import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, i18n } from 'vj/utils';
import Editor from 'vj/components/editor';
import { Dialog } from 'vj/components/dialog/index';
import uploadFiles from 'vj/components/upload';
import { nanoid } from 'nanoid';
interface BaseNode {
  id: string;
  text: string;
  x?: number;
  y?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  order?: number;
}

interface BaseEdge {
  id: string;
  source: string;
  target: string;
}

interface BaseDoc {
  docId?: string;
  bid?: number;
  title?: string;
  content?: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  currentBranch?: string;
  files?: Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>;
}

interface CardProblem {
  pid: string;
  type: 'single';
  stem: string;
  options: string[];
  answer: number; 
  analysis?: string;
  imageUrl?: string; 
  imageNote?: string; 
}

interface Card {
  docId: string;
  cid: number;
  title: string;
  content: string;
  /** Shown in lesson with Know it / No impression */
  cardFace?: string;
  updateAt: string;
  createdAt?: string;
  order?: number;
  nodeId?: string;
  problems?: CardProblem[];
}

type FileItem = {
  type: 'node' | 'card';
  id: string;
  name: string;
  nodeId?: string;
  cardId?: string;
  parentId?: string;
  level: number;
  hasPendingChanges?: boolean; 
  clipboardType?: 'copy' | 'cut'; 
};

interface PendingChange {
  file: FileItem;
  content: string;
  originalContent: string;
}

interface PendingRename {
  file: FileItem;
  newName: string;
  originalName: string;
}

interface PendingCreate {
  type: 'card' | 'node';
  nodeId: string;
  title?: string;
  text?: string;
  tempId: string;
}

interface PendingDelete {
  type: 'card' | 'node';
  id: string;
  nodeId?: string;
}

// Editable problem item
const EditableProblem = React.memo(({ 
  problem, 
  index, 
  cardId, 
  borderColor, 
  borderStyle,
  isNew, 
  isEdited,
  isPendingDelete,
  originalProblem,
  onUpdate,
  onDelete,
  docId,
  getBaseUrl,
  themeStyles
}: { 
  problem: CardProblem;
  index: number;
  cardId: string;
  borderColor: string;
  borderStyle: string;
  isNew: boolean;
  isEdited: boolean;
  isPendingDelete: boolean;
  originalProblem?: CardProblem;
  onUpdate: (updated: CardProblem) => void;
  onDelete: () => void;
  docId: string;
  getBaseUrl: (path: string, docId: string) => string;
  themeStyles: any;
}) => {
  const [problemStem, setProblemStem] = useState(problem.stem);
  const [problemOptions, setProblemOptions] = useState([...problem.options]);
  const [problemAnswer, setProblemAnswer] = useState(problem.answer);
  const [problemAnalysis, setProblemAnalysis] = useState(problem.analysis || '');
  const [problemImageUrl, setProblemImageUrl] = useState(problem.imageUrl || '');
  const [problemImageNote, setProblemImageNote] = useState(problem.imageNote || '');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Sync state when problem props change
  useEffect(() => {
    setProblemStem(problem.stem);
    setProblemOptions([...problem.options]);
    setProblemAnswer(problem.answer);
    setProblemAnalysis(problem.analysis || '');
    setProblemImageUrl(problem.imageUrl || '');
    setProblemImageNote(problem.imageNote || '');
  }, [problem.pid, problem.stem, problem.answer, problem.analysis, problem.imageUrl, problem.imageNote, JSON.stringify(problem.options)]);
  
  // Detect changes and call onUpdate
  useEffect(() => {
    const hasChanged = (
      problemStem !== problem.stem ||
      JSON.stringify(problemOptions) !== JSON.stringify(problem.options) ||
      problemAnswer !== problem.answer ||
      problemAnalysis !== (problem.analysis || '') ||
      problemImageUrl !== (problem.imageUrl || '') ||
      problemImageNote !== (problem.imageNote || '')
    );
    
    if (hasChanged) {
      const updated: CardProblem = {
        ...problem,
        stem: problemStem,
        options: problemOptions,
        answer: problemAnswer,
        analysis: problemAnalysis || undefined,
        imageUrl: problemImageUrl || undefined,
        imageNote: problemImageNote || undefined,
      };
      onUpdate(updated);
    }
  }, [problemStem, problemOptions, problemAnswer, problemAnalysis, problemImageUrl, problemImageNote, problem, onUpdate]);
  
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    let ext: string;
    const matches = file.type.match(/^image\/(png|jpg|jpeg|gif)$/i);
    if (matches) {
      [, ext] = matches;
    } else {
      Notification.error(i18n('Unsupported file type. Please upload an image (png, jpg, jpeg, gif).'));
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }
    
    setIsUploading(true);
    try {
      const filename = `${nanoid()}.${ext}`;
      
      await uploadFiles(getBaseUrl('/files', docId), [file], {
        filenameCallback: () => filename,
      });
      
      const imageUrl = getBaseUrl(`/${docId}/file/${encodeURIComponent(filename)}`, docId);
      setProblemImageUrl(imageUrl);
    } catch (error: any) {
      Notification.error(`${i18n('Image upload failed')}: ${error.message || i18n('Unknown error')}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };
  
  
  const handlePreviewImage = async () => {
    if (!problemImageUrl) return;
    try {
      const { InfoDialog } = await import('vj/components/dialog/index');
      const $ = (await import('jquery')).default;
      const { nanoid } = await import('nanoid');
      const { tpl } = await import('vj/utils');
      
      const id = nanoid();
      const dialog = new InfoDialog({
        $body: tpl`<div class="typo"><img src="${problemImageUrl}" style="max-height: calc(80vh - 45px);"></img></div>`,
        $action: [
          tpl`<button class="rounded button" data-action="copy" id="copy-${id}">${i18n('Copy link')}</button>`,
          tpl`<button class="rounded button" data-action="cancel">${i18n('Cancel')}</button>`,
          tpl`<button class="primary rounded button" data-action="download">${i18n('Download')}</button>`,
        ],
      });
      
      $(`#copy-${id}`).on('click', () => {
        navigator.clipboard.writeText(problemImageUrl).then(() => {
          Notification.success(i18n('Link copied to clipboard'));
        });
      });
      
      const action = await dialog.open();
      if (action === 'download') {
        window.open(problemImageUrl, '_blank');
      }
    } catch (error) {
      console.error('预览图片失败:', error);
      Notification.error(i18n('Image preview failed'));
    }
  };
  
  return (
    <div
      style={{
        border: `1px ${borderStyle} ${borderColor}`,
        borderRadius: '4px',
        padding: '6px 8px',
        marginBottom: '6px',
        background: themeStyles.bgPrimary,
        position: 'relative',
        opacity: isPendingDelete ? 0.5 : 1,
      }}
    >
      {/* Delete button */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          width: '20px',
          height: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          borderRadius: '3px',
          backgroundColor: '#f44336',
          color: '#fff',
          fontSize: '12px',
          fontWeight: 'bold',
          userSelect: 'none',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#d32f2f';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#f44336';
        }}
        title="删除题目"
      >
        ×
      </div>
      <div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px', paddingRight: '24px' }}>
        Q{index + 1}{i18n(' (single choice)')}
        {isNew && <span style={{ marginLeft: '8px', fontSize: '10px', color: themeStyles.success }}>{i18n('New')}</span>}
        {isEdited && !isNew && <span style={{ marginLeft: '8px', fontSize: '10px', color: themeStyles.warning }}>{i18n('Edited')}</span>}
        {isPendingDelete && <span style={{ marginLeft: '8px', fontSize: '10px', color: themeStyles.error }}>{i18n('Pending delete')}</span>}
      </div>
      <div style={{ marginBottom: '4px' }}>
        <textarea
          value={problemStem}
          onChange={e => setProblemStem(e.target.value)}
          placeholder={i18n('Stem')}
          style={{
            width: '100%',
            minHeight: '40px',
            resize: 'vertical',
            fontSize: '12px',
            padding: '4px 6px',
            boxSizing: 'border-box',
            border: `1px solid ${themeStyles.borderPrimary}`,
            borderRadius: '2px',
            backgroundColor: themeStyles.bgPrimary,
            color: themeStyles.textPrimary,
          }}
        />
      </div>
      {/* Image upload & preview */}
      <div style={{ marginBottom: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: problemImageUrl ? '4px' : '0' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            onChange={handleImageUpload}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            style={{
              padding: '2px 8px',
              fontSize: '11px',
              borderRadius: '3px',
              border: `1px solid ${themeStyles.accent}`,
              background: isUploading ? themeStyles.textTertiary : themeStyles.accent,
              color: themeStyles.textOnPrimary,
              cursor: isUploading ? 'not-allowed' : 'pointer',
            }}
          >
            {isUploading ? i18n('Uploading...') : i18n('Upload image')}
          </button>
          {problemImageUrl && (
            <button
              onClick={handlePreviewImage}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                borderRadius: '3px',
                border: `1px solid ${themeStyles.success}`,
                background: themeStyles.success,
                color: themeStyles.textOnPrimary,
                cursor: 'pointer',
              }}
            >
              {i18n('Preview image')}
            </button>
          )}
        </div>
        {/* Image note (when image present) */}
        {problemImageUrl && (
          <div style={{ marginTop: '4px' }}>
            <input
              type="text"
              value={problemImageNote}
              onChange={e => setProblemImageNote(e.target.value)}
              placeholder={i18n('Image note (optional)')}
              style={{
                width: '100%',
                fontSize: '11px',
                padding: '3px 6px',
                boxSizing: 'border-box',
                border: `1px solid ${themeStyles.borderPrimary}`,
                borderRadius: '2px',
                backgroundColor: themeStyles.bgPrimary,
                color: themeStyles.textPrimary,
              }}
            />
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '4px' }}>
        {problemOptions.map((opt, oi) => (
          <input
            key={oi}
            value={opt}
            onChange={e => {
              const next = [...problemOptions];
              next[oi] = e.target.value;
              setProblemOptions(next);
            }}
            placeholder={`${i18n('Option')} ${String.fromCharCode(65 + oi)}`}
            style={{
              fontSize: '12px',
              padding: '3px 6px',
              boxSizing: 'border-box',
              border: `1px solid ${themeStyles.borderPrimary}`,
              borderRadius: '2px',
              backgroundColor: themeStyles.bgPrimary,
              color: themeStyles.textPrimary,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', fontSize: '12px', color: themeStyles.textPrimary }}>
        <span style={{ marginRight: 4 }}>{i18n('Correct answer')}:</span>
        {problemOptions.map((_, oi) => (
          <label key={oi} style={{ marginRight: 6, cursor: 'pointer', color: themeStyles.textPrimary }}>
            <input
              type="radio"
              name={`problem-answer-${problem.pid}`}
              checked={problemAnswer === oi}
              onChange={() => setProblemAnswer(oi)}
              style={{ marginRight: 2 }}
            />
            {String.fromCharCode(65 + oi)}
          </label>
        ))}
      </div>
      <div style={{ marginBottom: '4px' }}>
        <textarea
          value={problemAnalysis}
          onChange={e => setProblemAnalysis(e.target.value)}
          placeholder={i18n('Analysis (optional)')}
          style={{
            width: '100%',
            minHeight: '32px',
            resize: 'vertical',
            fontSize: '12px',
            padding: '4px 6px',
            boxSizing: 'border-box',
            border: `1px solid ${themeStyles.borderPrimary}`,
            borderRadius: '2px',
            backgroundColor: themeStyles.bgPrimary,
            color: themeStyles.textPrimary,
          }}
        />
      </div>
    </div>
  );
});

// Sort window
function SortWindow({ 
  nodeId, 
  base, 
  docId,
  getBaseUrl,
  onClose, 
  onSave,
  nodeCardsMapVersion,
  themeStyles,
  theme
}: { 
  nodeId: string; 
  base: BaseDoc; 
  docId: string;
  getBaseUrl: (path: string, docId: string) => string;
  onClose: () => void; 
  onSave: (sortedItems: Array<{ type: 'node' | 'card'; id: string; order: number }>) => Promise<void>;
  nodeCardsMapVersion?: number;
  themeStyles: any;
  theme: 'light' | 'dark';
}) {
  const [draggedItem, setDraggedItem] = useState<{ type: 'node' | 'card'; id: string; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  
  const childNodes = useMemo(() => {
    return base.edges
      .filter(e => e.source === nodeId)
      .map(e => {
        const node = base.nodes.find(n => n.id === e.target);
        return node ? { 
          id: node.id, 
          name: node.text || i18n('Unnamed Node'),
          order: node.order || 0,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; name: string; order: number }>;
  }, [base.edges, base.nodes, nodeId]);
  
  const cards = useMemo(() => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || [])
      .filter((card: Card) => !card.nodeId || card.nodeId === nodeId)
      .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    return nodeCards.map((card: Card) => ({
      id: card.docId,
      name: card.title || i18n('Unnamed Card'),
      order: card.order || 0,
    }));
  }, [nodeId, nodeCardsMapVersion]); 
  
  
  const [items, setItems] = useState<Array<{ type: 'node' | 'card'; id: string; name: string; order: number }>>(() => {
    const allItems: Array<{ type: 'node' | 'card'; id: string; name: string; order: number }> = [
      ...childNodes.map(n => ({ type: 'node' as const, id: n.id, name: n.name, order: n.order })),
      ...cards.map(c => ({ type: 'card' as const, id: c.id, name: c.name, order: c.order })),
    ];
    return allItems.sort((a, b) => (a.order || 0) - (b.order || 0));
  });
  
  useEffect(() => {
    const allItems: Array<{ type: 'node' | 'card'; id: string; name: string; order: number }> = [
      ...childNodes.map(n => ({ type: 'node' as const, id: n.id, name: n.name, order: n.order })),
      ...cards.map(c => ({ type: 'card' as const, id: c.id, name: c.name, order: c.order })),
    ];
    
    setItems(allItems.sort((a, b) => (a.order || 0) - (b.order || 0)));
  }, [childNodes, cards]);
  
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedItem({ type: items[index].type, id: items[index].id, index });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', '');
  };
  
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedItem && draggedItem.index !== index) {
      setDragOverIndex(index);
    }
  };
  
  const handleDragLeave = () => {
    setDragOverIndex(null);
  };
  
  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.index === index) {
      setDragOverIndex(null);
      setDraggedItem(null);
      return;
    }
    
    const newItems = [...items];
    const [removed] = newItems.splice(draggedItem.index, 1);
    newItems.splice(index, 0, removed);
    setItems(newItems);
    
    setDragOverIndex(null);
    setDraggedItem(null);
  };
  
  const handleDragEnd = () => {
    setDragOverIndex(null);
    setDraggedItem(null);
  };
  
  const handleSave = async () => {
    const sortedItems: Array<{ type: 'node' | 'card'; id: string; order: number }> = [];
    
    for (let i = 0; i < items.length; i++) {
      sortedItems.push({
        type: items[i].type,
        id: items[i].id,
        order: i + 1,
      });
    }
    
    await onSave(sortedItems);
  };
  
  const currentNode = base.nodes.find(n => n.id === nodeId);
  
  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            backgroundColor: themeStyles.bgPrimary,
            borderRadius: '8px',
            padding: '20px',
            minWidth: '500px',
            maxWidth: '80%',
            maxHeight: '80%',
            overflow: 'auto',
            boxShadow: theme === 'dark' ? '0 4px 20px rgba(0,0,0,0.5)' : '0 4px 20px rgba(0,0,0,0.3)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: themeStyles.textPrimary }}>
              {i18n('Sort')}: {currentNode?.text || i18n('Unnamed Node')}
            </h3>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                color: themeStyles.textTertiary,
                padding: '0',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
          
          <div style={{ marginBottom: '16px', fontSize: '13px', color: themeStyles.textTertiary }}>
            {i18n('Drag items to reorder')}
          </div>
          
          <div style={{ marginBottom: '16px' }}>
            {items.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: themeStyles.textTertiary }}>
                {i18n('No child nodes or cards')}
              </div>
            ) : (
              items.map((item, index) => (
                <div
                  key={`${item.type}-${item.id}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  style={{
                    padding: '12px',
                    marginBottom: '8px',
                    backgroundColor: dragOverIndex === index ? themeStyles.bgDragOver : draggedItem?.index === index ? themeStyles.bgDragged : themeStyles.bgPrimary,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: '4px',
                    cursor: 'move',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    opacity: draggedItem?.index === index ? 0.5 : 1,
                    transition: 'background-color 0.2s',
                  }}
                >
                  <div style={{ fontSize: '18px', color: themeStyles.textTertiary }}>⋮⋮</div>
                  <div style={{ 
                    padding: '2px 8px', 
                    borderRadius: '3px', 
                    fontSize: '12px',
                    backgroundColor: item.type === 'node' ? themeStyles.accent : themeStyles.success,
                    color: themeStyles.textOnPrimary,
                    fontWeight: '500',
                  }}>
                    {item.type === 'node' ? 'Node' : 'Card'}
                  </div>
                  <div style={{ flex: 1, fontSize: '14px', color: themeStyles.textPrimary }}>
                    {item.name}
                  </div>
                </div>
              ))
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              onClick={onClose}
              style={{
                padding: '6px 16px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '4px',
                backgroundColor: themeStyles.bgButton,
                color: themeStyles.textPrimary,
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              {i18n('Cancel')}
            </button>
            <button
              onClick={handleSave}
              style={{
                padding: '6px 16px',
                border: `1px solid ${themeStyles.success}`,
                borderRadius: '4px',
                backgroundColor: themeStyles.success,
                color: themeStyles.textOnPrimary,
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '500',
              }}
            >
              {i18n('Save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Assign order to nodes/cards that lack it; returns migrated base and needsSave
function migrateOrderFields(base: BaseDoc): { base: BaseDoc; needsSave: boolean; cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> } {
  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
  let needsSave = false;
  const cardUpdates: Array<{ cardId: string; nodeId: string; order: number }> = [];
  
  const nodesNeedMigration = base.nodes.some(node => node.order === undefined);
  
  let cardsNeedMigration = false;
  for (const nodeId in nodeCardsMap) {
    const cards = nodeCardsMap[nodeId] || [];
    if (cards.some((card: Card) => card.order === undefined)) {
      cardsNeedMigration = true;
      break;
    }
  }
  
  if (!nodesNeedMigration && !cardsNeedMigration) {
    return { base, needsSave: false, cardUpdates: [] };
  }
  
  needsSave = true;
  
  
  const nodeMap = new Map<string, BaseNode>();
  base.nodes.forEach(node => {
    nodeMap.set(node.id, { ...node });
  });
  
  
  const processedNodes = new Set<string>();
  
  const assignOrderToChildren = (parentId: string) => {
    if (processedNodes.has(parentId)) return;
    processedNodes.add(parentId);
    
    
    const childEdges = base.edges
      .filter(e => e.source === parentId)
      .map(e => {
        const node = nodeMap.get(e.target);
        return node ? { node, edge: e } : null;
      })
      .filter(Boolean) as Array<{ node: BaseNode; edge: BaseEdge }>;
    
    if (childEdges.some(item => item.node.order === undefined)) {
      childEdges.forEach((item, index) => {
        if (item.node.order === undefined) {
          item.node.order = index + 1;
        }
      });
    }
    
    childEdges.forEach(item => {
      assignOrderToChildren(item.node.id);
    });
  };
  
  const rootNodes = base.nodes.filter(node => 
    !base.edges.some(edge => edge.target === node.id)
  );
  
  rootNodes.forEach(rootNode => {
    assignOrderToChildren(rootNode.id);
  });
  
  
  for (const nodeId in nodeCardsMap) {
    const cards = nodeCardsMap[nodeId] || [];
    const cardsNeedOrder = cards.filter((card: Card) => card.order === undefined);
    
    if (cardsNeedOrder.length > 0) {
      const maxOrder = cards
        .filter((card: Card) => card.order !== undefined)
        .reduce((max: number, card: Card) => Math.max(max, card.order || 0), 0);
      
      
      cardsNeedOrder.forEach((card: Card, index: number) => {
        const newOrder = maxOrder + index + 1;
        card.order = newOrder;
        cardUpdates.push({
          cardId: card.docId,
          nodeId: nodeId,
          order: newOrder,
        });
      });
    }
  }
  
  if (cardsNeedMigration) {
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
  }
  
  return {
    base: {
      ...base,
      nodes: Array.from(nodeMap.values()),
    },
    needsSave,
    cardUpdates,
  };
}

export function BaseEditorMode({ docId, initialData, basePath = 'base' }: { docId: string | undefined; initialData: BaseDoc; basePath?: string }) {
  
  const getTheme = useCallback(() => {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) {
        return (window as any).Ejunz.utils.getTheme();
      }
      if ((window as any).UserContext?.theme) {
        return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
      }
    } catch (e) {
      console.warn('Failed to get theme:', e);
    }
    return 'light';
  }, []);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => getTheme());
  const [contributionData, setContributionData] = useState<{
    todayContribution: { nodes: number; cards: number; problems: number; nodeChars?: number; cardChars?: number; problemChars?: number };
    todayContributionAllDomains: { nodes: number; cards: number; problems: number; nodeChars?: number; cardChars?: number; problemChars?: number };
    contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }>;
    contributionDetails: Record<string, Array<{
      domainId: string; domainName: string; nodes: number; cards: number; problems: number;
      nodeStats: { created: number; modified: number; deleted: number };
      cardStats: { created: number; modified: number; deleted: number };
      problemStats: { created: number; modified: number; deleted: number };
    }>>;
  }>(() => {
    const ctx = (window as any).UiContext;
    const defaultChars = { nodeChars: 0, cardChars: 0, problemChars: 0 };
    return {
      todayContribution: { ...defaultChars, ...ctx?.todayContribution, nodes: ctx?.todayContribution?.nodes ?? 0, cards: ctx?.todayContribution?.cards ?? 0, problems: ctx?.todayContribution?.problems ?? 0 },
      todayContributionAllDomains: { ...defaultChars, ...ctx?.todayContributionAllDomains, nodes: ctx?.todayContributionAllDomains?.nodes ?? 0, cards: ctx?.todayContributionAllDomains?.cards ?? 0, problems: ctx?.todayContributionAllDomains?.problems ?? 0 },
      contributions: ctx?.contributions || [],
      contributionDetails: ctx?.contributionDetails || {},
    };
  });
  const contributionWsRef = useRef<any>(null);
  const saveHandlerRef = useRef<() => void>(() => {});

  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) {
        setTheme(newTheme);
      }
    };

    checkTheme();
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);

  // WebSocket：连接 base/ws（ConnectionHandler），收到 init/update 时更新贡献数据（保存后实时刷新贡献墙）
  useEffect(() => {
    const socketUrl = (window as any).UiContext?.socketUrl;
    const wsPrefix = (window as any).UiContext?.ws_prefix || '';
    if (!socketUrl) return;

    let closed = false;
    const connect = async () => {
      try {
        const { default: WebSocket } = await import('../components/socket');
        const wsUrl = wsPrefix + socketUrl;
        const sock = new WebSocket(wsUrl, false, true);
        contributionWsRef.current = sock;

        sock.onmessage = (_: any, data: string) => {
          if (closed) return;
          try {
            const msg = JSON.parse(data);
            if ((msg.type === 'init' || msg.type === 'update') && msg.todayContribution != null) {
              setContributionData(prev => ({
                ...prev,
                todayContribution: msg.todayContribution || prev.todayContribution,
                todayContributionAllDomains: msg.todayContributionAllDomains || prev.todayContributionAllDomains,
                contributions: Array.isArray(msg.contributions) ? msg.contributions : prev.contributions,
                contributionDetails: msg.contributionDetails && typeof msg.contributionDetails === 'object'
                  ? msg.contributionDetails
                  : prev.contributionDetails,
              }));
            }
          } catch (e) {
            // ignore parse error
          }
        };

        sock.onclose = () => {
          contributionWsRef.current = null;
        };
      } catch (e) {
        console.warn('Contribution WS connect failed:', e);
      }
    };

    connect();
    return () => {
      closed = true;
      if (contributionWsRef.current) {
        contributionWsRef.current.close();
        contributionWsRef.current = null;
      }
    };
  }, []);

  const themeStyles = useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bgPrimary: isDark ? '#121212' : '#fff',
      bgSecondary: isDark ? '#323334' : '#f6f8fa',
      bgTertiary: isDark ? '#424242' : '#fafbfc',
      bgHover: isDark ? '#424242' : '#f3f4f6',
      bgSelected: isDark ? '#0366d6' : '#0366d6',
      bgDragOver: isDark ? '#1e3a5f' : '#e3f2fd',
      bgDragged: isDark ? '#2a2a2a' : '#f0f0f0',
      bgButton: isDark ? '#323334' : '#fff',
      bgButtonActive: isDark ? '#0366d6' : '#0366d6',
      bgButtonHover: isDark ? '#424242' : '#f3f4f6',
      
      
      textPrimary: isDark ? '#eee' : '#24292e',
      textSecondary: isDark ? '#bdbdbd' : '#586069',
      textTertiary: isDark ? '#999' : '#6a737d',
      textOnPrimary: isDark ? '#fff' : '#fff',
      
      borderPrimary: isDark ? '#424242' : '#e1e4e8',
      borderSecondary: isDark ? '#555' : '#d1d5da',
      borderFocus: isDark ? '#0366d6' : '#0366d6',
      
      accent: isDark ? '#55b6e2' : '#0366d6',
      success: isDark ? '#4caf50' : '#28a745',
      warning: isDark ? '#ff9800' : '#ff9800',
      error: isDark ? '#f44336' : '#f44336',
      statNode: isDark ? '#64b5f6' : '#2196F3',
      statCard: isDark ? '#81c784' : '#4CAF50',
      statProblem: isDark ? '#ffb74d' : '#FF9800',
    };
  }, [theme]);

  const migrationResult = useMemo(() => migrateOrderFields(initialData), [initialData]);
  const [base, setBase] = useState<BaseDoc>(() => migrationResult.base);
  
  useEffect(() => {
    if (migrationResult.needsSave) {
      const saveMigration = async () => {
        try {
          const migrationNodes = migrationResult.base.nodes.filter(n => !n.id.startsWith('temp-node-'));
          const migrationEdges = migrationResult.base.edges.filter(e => 
            !e.source.startsWith('temp-node-') && 
            !e.target.startsWith('temp-node-') &&
            !e.id.startsWith('temp-edge-')
          );
          
          await request.post(getBaseUrl('/save'), {
            nodes: migrationNodes,
            edges: migrationEdges,
            operationDescription: '自动迁移：为节点和卡片添加order字段',
          });
          
          if (migrationResult.cardUpdates.length > 0) {
            const domainId = (window as any).UiContext?.domainId || 'system';
            const updatePromises = migrationResult.cardUpdates.map(update =>
              request.post(getBaseUrl(`/card/${update.cardId}`), {
                operation: 'update',
                nodeId: update.nodeId,
                order: update.order,
              })
            );
            await Promise.all(updatePromises);
          }
          
          console.log('Order migration done');
        } catch (error: any) {
          console.error('Order migration failed:', error);
        }
      };
      
      saveMigration();
    }
  }, [migrationResult.needsSave, migrationResult.base.nodes, migrationResult.base.edges, migrationResult.cardUpdates, docId]);
  
  useEffect(() => {
    pendingCreatesRef.current.clear();
    setPendingCreatesCount(0);
    setPendingChanges(new Map());
    setPendingRenames(new Map());
    setPendingDeletes(new Map());
    setPendingDragChanges(new Set());
  }, [docId]);
  
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState<boolean>(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const getNodeChildrenRef = useRef<((nodeId: string, visited?: Set<string>) => { nodes: string[]; cards: string[] }) | null>(null);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [pendingRenames, setPendingRenames] = useState<Map<string, PendingRename>>(new Map());
  const pendingCreatesRef = useRef<Map<string, PendingCreate>>(new Map());
  const [pendingCreatesCount, setPendingCreatesCount] = useState<number>(0);
  const [pendingDeletes, setPendingDeletes] = useState<Map<string, PendingDelete>>(new Map());
  const originalContentsRef = useRef<Map<string, string>>(new Map());
  const [draggedFile, setDraggedFile] = useState<FileItem | null>(null);
  const [dragOverFile, setDragOverFile] = useState<FileItem | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'into'>('after');
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [pendingDragChanges, setPendingDragChanges] = useState<Set<string>>(new Set());
  const [nodeCardsMapVersion, setNodeCardsMapVersion] = useState(0);
  const dragLeaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dragOverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastDragOverFileRef = useRef<FileItem | null>(null);
  const lastDropPositionRef = useRef<'before' | 'after' | 'into'>('after');
  const longPressTimerRef = useRef<number | null>(null);
  const longPressFileRef = useRef<FileItem | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const mobileExplorerCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const touchDragFileRef = useRef<FileItem | null>(null);
  const touchDragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const touchDragOverFileRef = useRef<FileItem | null>(null);
  const touchDropPositionRef = useRef<'before' | 'after' | 'into'>('after');
  const touchDragListenersRef = useRef<{
    move: (e: TouchEvent) => void;
    end: (e: TouchEvent) => void;
    cancel: (e: TouchEvent) => void;
  } | null>(null);
  const fileTreeRef = useRef<FileItem[]>([]);
  const baseEdgesRef = useRef(base.edges);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem } | null>(null);
  const [emptyAreaContextMenu, setEmptyAreaContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboard, setClipboard] = useState<{ type: 'copy' | 'cut'; items: FileItem[] } | null>(null);
  const [sortWindow, setSortWindow] = useState<{ nodeId: string } | null>(null);
  const [importWindow, setImportWindow] = useState<{ nodeId: string } | null>(null);
  const [cardFaceWindow, setCardFaceWindow] = useState<{ file: FileItem } | null>(null);
  const [cardFaceEditContent, setCardFaceEditContent] = useState('');
  const [pendingCardFaceChanges, setPendingCardFaceChanges] = useState<Record<string, string>>({});
  const cardFaceEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const cardFaceEditorInstanceRef = useRef<any>(null);
  const [importText, setImportText] = useState('');
  const [showAIChat, setShowAIChat] = useState<boolean>(false);
  const [showProblemPanel, setShowProblemPanel] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<Array<{ 
    role: 'user' | 'assistant' | 'operation'; 
    content: string; 
    references?: Array<{ type: 'node' | 'card'; id: string; name: string; path: string[] }>;
    operations?: any[];
    isExpanded?: boolean;
  }>>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatInputReferences, setChatInputReferences] = useState<Array<{ type: 'node' | 'card'; id: string; name: string; path: string[]; startIndex: number; endIndex: number }>>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesContainerRef = useRef<HTMLDivElement>(null);
  
  const scrollToBottomIfNeeded = useCallback(() => {
    if (!chatMessagesContainerRef.current || !chatMessagesEndRef.current) {
      return;
    }
    
    const container = chatMessagesContainerRef.current;
    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    
    if (isNearBottom) {
      requestAnimationFrame(() => {
        if (chatMessagesContainerRef.current) {
          chatMessagesContainerRef.current.scrollTop = chatMessagesContainerRef.current.scrollHeight;
        }
      });
    }
  }, []);
  
  const [chatPanelWidth, setChatPanelWidth] = useState<number>(300);
  const PROBLEM_PANEL_WIDTH = 360;
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartWidthRef = useRef<number>(300);
  const executeAIOperationsRef = useRef<((operations: any[]) => Promise<{ success: boolean; errors: string[] }>) | null>(null);
  const chatWebSocketRef = useRef<any>(null);
  const [explorerMode, setExplorerMode] = useState<'tree' | 'files' | 'pending'>('tree');
  const [domainTools, setDomainTools] = useState<any[]>([]);
  const [domainToolsLoading, setDomainToolsLoading] = useState<boolean>(false);
  const [files, setFiles] = useState<Array<{ _id: string; name: string; size: number; etag?: string; lastModified?: Date | string }>>(initialData.files || []);
  const [selectedFileForPreview, setSelectedFileForPreview] = useState<string | null>(null);
  const [problemStem, setProblemStem] = useState<string>('');
  const [problemOptions, setProblemOptions] = useState<string[]>(['', '', '', '']);
  const [problemAnswer, setProblemAnswer] = useState<number>(0);
  const [problemAnalysis, setProblemAnalysis] = useState<string>('');
  const [isSavingProblem, setIsSavingProblem] = useState<boolean>(false);
  const [showProblemForm, setShowProblemForm] = useState<boolean>(false);
  const [pendingProblemCardIds, setPendingProblemCardIds] = useState<Set<string>>(new Set());
  const [pendingNewProblemCardIds, setPendingNewProblemCardIds] = useState<Set<string>>(new Set());
  const [pendingEditedProblemIds, setPendingEditedProblemIds] = useState<Map<string, Set<string>>>(new Map());
  const [pendingDeleteProblemIds, setPendingDeleteProblemIds] = useState<Map<string, string>>(new Map());
  const [newProblemIds, setNewProblemIds] = useState<Set<string>>(new Set());
  const [editedProblemIds, setEditedProblemIds] = useState<Set<string>>(new Set());
  const originalProblemsRef = useRef<Map<string, Map<string, CardProblem>>>(new Map());
  const [originalProblemsVersion, setOriginalProblemsVersion] = useState(0);
  const [isGeneratingProblemWithAgent, setIsGeneratingProblemWithAgent] = useState<boolean>(false);

  const MOBILE_BREAKPOINT = 768;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!isMobile) return;
    const leftEl = document.getElementById('header-mobile-extra-left');
    if (!leftEl) return;
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';
    leftEl.appendChild(wrapper);
    ReactDOM.render(
      <>
        <button type="button" onClick={() => setMobileExplorerOpen(true)} aria-label="Explorer">
          ☰ Explorer
        </button>
        {selectedFile?.type === 'card' && (
          <button
            type="button"
            className={showProblemPanel ? 'header-mobile-extra-btn is-active' : 'header-mobile-extra-btn'}
            onClick={() => setShowProblemPanel((prev) => !prev)}
            aria-label={i18n('Question')}
          >
            {i18n('Question')}
          </button>
        )}
      </>,
      wrapper,
    );
    return () => {
      ReactDOM.unmountComponentAtNode(wrapper);
      wrapper.remove();
    };
  }, [isMobile, showProblemPanel, selectedFile?.type]);

  useEffect(() => {
    if (!isMobile) return;
    const rightEl = document.getElementById('header-mobile-extra');
    if (!rightEl) return;
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';
    rightEl.appendChild(wrapper);
    const pendingCount = pendingChanges.size + pendingDragChanges.size + pendingRenames.size + pendingCreatesCount + pendingDeletes.size + Object.keys(pendingCardFaceChanges).length + pendingNewProblemCardIds.size + pendingEditedProblemIds.size + pendingDeleteProblemIds.size;
    const hasPending = pendingCount > 0;
    ReactDOM.render(
      <>
        <button
          type="button"
          className="header-mobile-extra-btn"
          onClick={() => saveHandlerRef.current?.()}
          disabled={isCommitting || !hasPending}
          style={{
            opacity: isCommitting || !hasPending ? 0.6 : 1,
            cursor: isCommitting || !hasPending ? 'not-allowed' : 'pointer',
            background: hasPending ? 'var(--color-success, #28a745)' : undefined,
            color: hasPending ? '#fff' : undefined,
          }}
          aria-label={i18n('Save changes')}
        >
          {isCommitting ? i18n('Saving...') : `${i18n('Save changes')} (${pendingCount})`}
        </button>
        <button
          type="button"
          className={showAIChat ? 'header-mobile-extra-btn is-active' : 'header-mobile-extra-btn'}
          onClick={() => setShowAIChat((prev) => !prev)}
          aria-label="AI"
        >
          AI
        </button>
      </>,
      wrapper,
    );
    return () => {
      ReactDOM.unmountComponentAtNode(wrapper);
      wrapper.remove();
    };
  }, [isMobile, showAIChat, showProblemPanel, selectedFile?.type, isCommitting, pendingChanges.size, pendingDragChanges.size, pendingRenames.size, pendingCreatesCount, pendingDeletes.size, pendingCardFaceChanges, pendingNewProblemCardIds.size, pendingEditedProblemIds.size, pendingDeleteProblemIds.size]);

  
  const getSelectedCard = useCallback((): Card | null => {
    if (!selectedFile || selectedFile.type !== 'card') return null;
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[selectedFile.nodeId || ''] || [];
    const card = nodeCards.find((c: Card) => c.docId === selectedFile.cardId);
    return card || null;
  }, [selectedFile]);

  
  useEffect(() => {
    setProblemStem('');
    setProblemOptions(['', '', '', '']);
    setProblemAnswer(0);
    setProblemAnalysis('');
    setShowProblemForm(false);
    
    
    if (selectedFile && selectedFile.type === 'card') {
      const card = getSelectedCard();
      if (card && card.problems) {
        const cardIdStr = String(selectedFile.cardId || '');
        const originalProblems = new Map<string, CardProblem>();
        card.problems.forEach(p => {
          originalProblems.set(p.pid, { ...p });
        });
        originalProblemsRef.current.set(cardIdStr, originalProblems);
      }
    }
  }, [selectedFile?.id]);
  
  
  useEffect(() => {
    if (base.files) {
      setFiles(base.files);
    }
  }, [base.files]);
  
  
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const initialExpanded = new Set<string>();
    
    
    if (initialData?.nodes) {
      initialData.nodes.forEach(node => {
        if (node.expanded !== false) {
          initialExpanded.add(node.id);
        }
      });
    }
    return initialExpanded;
  });
  
  
  const expandSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  const expandedNodesRef = useRef<Set<string>>(expandedNodes);
  
  const baseRef = useRef<BaseDoc>(base);
  
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  const hasExpandedForCardIdRef = useRef<string | null>(null);
  
  
  useEffect(() => {
    expandedNodesRef.current = expandedNodes;
  }, [expandedNodes]);
  
  useEffect(() => {
    baseRef.current = base;
  }, [base]);
  
  
  useEffect(() => {
    return () => {
      if (expandSaveTimerRef.current) {
        clearTimeout(expandSaveTimerRef.current);
        expandSaveTimerRef.current = null;
      }
    };
  }, []);

  
  const getBaseUrl = useCallback((path: string, docId?: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    
    return `/d/${domainId}/${basePath}${path}`;
  }, [basePath]);

  
  const fileTree = useMemo(() => {
    const items: FileItem[] = [];
    const nodeMap = new Map<string, { node: BaseNode; children: string[] }>();
    const rootNodes: string[] = [];

    
    base.nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

    
    base.edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });
    
    
    nodeMap.forEach((nodeData) => {
      nodeData.children.sort((a, b) => {
        const nodeA = base.nodes.find(n => n.id === a);
        const nodeB = base.nodes.find(n => n.id === b);
        const orderA = nodeA?.order || 0;
        const orderB = nodeB?.order || 0;
        return orderA - orderB;
      });
    });

    
    base.nodes.forEach((node) => {
      const hasParent = base.edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });

    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    
    
    const deletedNodeIds = new Set(
      Array.from(pendingDeletes.values())
        .filter(d => d.type === 'node')
        .map(d => d.id)
    );
    const deletedCardIds = new Set(
      Array.from(pendingDeletes.values())
        .filter(d => d.type === 'card')
        .map(d => d.id)
    );

    
    const checkAncestorMoved = (nodeId: string): boolean => {
      
      if (pendingDragChanges.has(`node-${nodeId}`)) return true;
      
      
      const parentEdge = base.edges.find(e => e.target === nodeId);
      if (parentEdge) {
        
        return checkAncestorMoved(parentEdge.source);
      }
      
      return false;
    };

    
    const checkClipboard = (file: { type: 'node' | 'card'; id: string; nodeId?: string; cardId?: string }): 'copy' | 'cut' | undefined => {
      if (!clipboard) return undefined;
      
      const found = clipboard.items.find(item => {
        if (file.type === 'node') {
          return item.type === 'node' && item.nodeId === file.nodeId;
        } else if (file.type === 'card') {
          return item.type === 'card' && item.cardId === file.cardId;
        }
        return false;
      });
      
      return found ? clipboard.type : undefined;
    };

    
    const checkPendingChanges = (file: { type: 'node' | 'card'; id: string; nodeId?: string; cardId?: string; parentId?: string }): boolean => {
      
      if (pendingChanges.has(file.id)) return true;
      
      
      if (pendingRenames.has(file.id)) return true;
      
      
      if (file.type === 'card' && file.cardId && pendingProblemCardIds.has(String(file.cardId))) return true;
      
      
      
      
      if (file.id.startsWith('temp-') || 
          (file.type === 'card' && file.cardId && file.cardId.startsWith('temp-')) ||
          (file.type === 'card' && file.id.startsWith('card-temp-')) ||
          Array.from(pendingCreatesRef.current.values()).some(c => {
            
            if (file.type === 'node' && c.type === 'node' && c.tempId === file.id) return true;
            
            if (file.type === 'card' && c.type === 'card' && file.id === `card-${c.tempId}`) return true;
            return false;
          })) return true;
      
      
      if (file.type === 'node' && file.nodeId) {
        
        if (pendingDragChanges.has(`node-${file.nodeId}`)) return true;
        
        if (checkAncestorMoved(file.nodeId)) return true;
      } else if (file.type === 'card') {
        
        if (file.cardId && pendingDragChanges.has(file.cardId)) return true;
        
        if (file.nodeId && checkAncestorMoved(file.nodeId)) return true;
      }
      
      return false;
    };

    
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      
      if (deletedNodeIds.has(nodeId)) return;
      
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node } = nodeData;
      const isExpanded = expandedNodes.has(nodeId);
      
      
      const nodeFileItem: FileItem = {
        type: 'node',
        id: nodeId,
        name: node.text || i18n('Unnamed Node'),
        nodeId: nodeId,
        parentId,
        level,
      };
      nodeFileItem.hasPendingChanges = checkPendingChanges(nodeFileItem);
      nodeFileItem.clipboardType = checkClipboard(nodeFileItem);
      items.push(nodeFileItem);

      
      if (isExpanded) {
        
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((card: Card) => {
            
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        
        const childNodes = nodeData.children
          .map(childId => {
            const childNode = base.nodes.find(n => n.id === childId);
            return childNode ? { id: childId, node: childNode, order: childNode.order || 0 } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;
        
        
        const existingCardIds = new Set((nodeCardsMap[nodeId] || []).map((c: Card) => c.docId));
        const existingNodeIds = new Set(base.nodes.map(n => n.id));
        
        
        const pendingCards = Array.from(pendingCreatesRef.current.values())
          .filter(c => c.type === 'card' && c.nodeId === nodeId && !existingCardIds.has(c.tempId))
          .map(create => {
            
            const tempCard = (nodeCardsMap[nodeId] || []).find((c: Card) => c.docId === create.tempId);
            const maxCardOrder = nodeCards.length > 0 ? Math.max(...nodeCards.map((c: Card) => c.order || 0)) : 0;
            const maxNodeOrder = childNodes.length > 0 ? Math.max(...childNodes.map(n => n.order || 0)) : 0;
            const maxOrder = Math.max(maxCardOrder, maxNodeOrder);
            return {
              type: 'card' as const,
              id: create.tempId,
              order: tempCard?.order || maxOrder + 1,
              data: tempCard || { docId: create.tempId, title: create.title || i18n('New card'), nodeId, order: maxOrder + 1 },
              isPending: true,
            };
          });
        
        
        const pendingNodes = Array.from(pendingCreatesRef.current.values())
          .filter(c => c.type === 'node' && c.nodeId === nodeId && !existingNodeIds.has(c.tempId))
          .map(create => {
            
            const tempNode = base.nodes.find(n => n.id === create.tempId);
            const maxCardOrder = nodeCards.length > 0 ? Math.max(...nodeCards.map((c: Card) => c.order || 0)) : 0;
            const maxNodeOrder = childNodes.length > 0 ? Math.max(...childNodes.map(n => n.order || 0)) : 0;
            const maxOrder = Math.max(maxCardOrder, maxNodeOrder);
            return {
              type: 'node' as const,
              id: create.tempId,
              order: tempNode?.order || maxOrder + 1,
              data: tempNode || { id: create.tempId, text: create.text || i18n('New node'), order: maxOrder + 1 },
              isPending: true,
            };
          });
        
        
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any; isPending?: boolean }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node, isPending: false })),
          ...nodeCards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c, isPending: false })),
          ...pendingNodes,
          ...pendingCards,
        ];
        
        
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        
        allChildren.forEach(item => {
          if (item.type === 'card') {
            const card = item.data as Card;
            
            if (deletedCardIds.has(card.docId)) return;
            
            const cardFileItem: FileItem = {
              type: 'card',
              id: item.isPending ? card.docId : `card-${card.docId}`,
              name: card.title || i18n('Unnamed Card'),
              nodeId: card.nodeId || nodeId,
              cardId: card.docId,
              parentId: card.nodeId || nodeId,
              level: level + 1,
            };
            cardFileItem.hasPendingChanges = item.isPending || checkPendingChanges(cardFileItem);
            cardFileItem.clipboardType = checkClipboard(cardFileItem);
            items.push(cardFileItem);
          } else {
            buildTree(item.id, level + 1, nodeId);
          }
        });
      }
    };

    rootNodes.forEach((rootId) => {
      buildTree(rootId, 0);
    });
    
    
    
    const existingNodeIds = new Set(base.nodes.map(n => n.id));
    Array.from(pendingCreatesRef.current.values())
      .filter(c => c.type === 'node' && !c.nodeId && !existingNodeIds.has(c.tempId))
      .forEach(create => {
        const createFileItem: FileItem = {
          type: 'node',
          id: create.tempId,
          name: create.text || i18n('New node'),
          nodeId: create.tempId,
          level: 0,
        };
        createFileItem.hasPendingChanges = true;
        items.push(createFileItem);
      });

    return items;
  }, [base.nodes, base.edges, nodeCardsMapVersion, expandedNodes, pendingChanges, pendingRenames, pendingDragChanges, pendingDeletes, clipboard]);

  useEffect(() => {
    fileTreeRef.current = fileTree;
    baseEdgesRef.current = base.edges;
  }, [fileTree, base.edges]);

  
  const triggerExpandAutoSave = useCallback(() => {
    
    if (expandSaveTimerRef.current) {
      clearTimeout(expandSaveTimerRef.current);
      expandSaveTimerRef.current = null;
    }

    expandSaveTimerRef.current = setTimeout(async () => {
      try {
        
        const currentExpandedNodes = expandedNodesRef.current;
        const currentBase = baseRef.current;
        
        
        const updatedNodes = currentBase.nodes.map((node) => {
          const isExpanded = currentExpandedNodes.has(node.id);
          return {
            ...node,
            expanded: isExpanded,
          };
        });

        
        
        const filteredNodes = updatedNodes.filter(n => !n.id.startsWith('temp-node-'));
        const filteredEdges = currentBase.edges.filter(e => 
          !e.source.startsWith('temp-node-') && 
          !e.target.startsWith('temp-node-') &&
          !e.id.startsWith('temp-edge-')
        );
        
        await request.post(getBaseUrl('/save'), {
          nodes: filteredNodes,
          edges: filteredEdges,
          operationDescription: '自动保存展开状态',
        });
        
        
        setBase(prev => ({
          ...prev,
          nodes: updatedNodes,
        }));
        
        expandSaveTimerRef.current = null;
      } catch (error: any) {
        console.error('保存展开状态失败:', error);
        expandSaveTimerRef.current = null;
      }
    }, 1500);
  }, [docId]);

  
  const toggleNodeExpanded = useCallback((nodeId: string) => {
    let newExpandedState: boolean;
    
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      const isExpanded = newSet.has(nodeId);
      newExpandedState = !isExpanded;
      
      if (isExpanded) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      
      
      expandedNodesRef.current = newSet;
      
      
      setBase(prev => {
        const updated = {
          ...prev,
          nodes: prev.nodes.map(n =>
            n.id === nodeId
              ? { ...n, expanded: newExpandedState }
              : n
          ),
        };
        
        baseRef.current = updated;
        return updated;
      });
      
      return newSet;
    });
    
    
    triggerExpandAutoSave();
  }, [triggerExpandAutoSave]);

  
  const handleSelectFile = useCallback(async (file: FileItem, skipUrlUpdate = false) => {
    
    if (isMultiSelectMode) {
      
      setSelectedItems(prev => {
        const next = new Set(prev);
        const isSelected = next.has(file.id);
        
        if (isSelected) {
          
          next.delete(file.id);
          
          
          if (file.type === 'node' && getNodeChildrenRef.current) {
            const children = getNodeChildrenRef.current(file.nodeId || '');
            children.nodes.forEach(nodeId => {
              const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
              if (nodeFile) next.delete(nodeFile.id);
            });
            children.cards.forEach(cardId => {
              const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
              if (cardFile) next.delete(cardFile.id);
            });
          }
        } else {
          
          next.add(file.id);
          
          
          if (file.type === 'node' && getNodeChildrenRef.current) {
            const children = getNodeChildrenRef.current(file.nodeId || '');
            children.nodes.forEach(nodeId => {
              const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
              if (nodeFile) next.add(nodeFile.id);
            });
            children.cards.forEach(cardId => {
              const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
              if (cardFile) next.add(cardFile.id);
            });
          }
        }
        
        return next;
      });
      return;
    }
    
    // 单选模式：仅当多选集合非空时清空，避免多余 setState；并先更新选中状态，再延后内容相关更新，保证高亮及时
    if (selectedItems.size > 0) setSelectedItems(new Set());
    
    
    if (file.type === 'node') {
      return;
    }
    
    
    let pendingChangeToSave: { file: FileItem; content: string; originalContent: string } | null = null;
    if (selectedFile && editorInstance) {
      try {
        const currentContent = editorInstance.value() || fileContent;
        const originalContent = originalContentsRef.current.get(selectedFile.id) || '';
        if (currentContent !== originalContent) {
          pendingChangeToSave = { file: selectedFile, content: currentContent, originalContent };
        }
      } catch (error) {
      }
    }
    
    setSelectedFile(file);
    selectedFileRef.current = file;
    
    
    if (!skipUrlUpdate && file.type === 'card' && file.cardId) {
      const urlParams = new URLSearchParams(window.location.search);
      urlParams.set('cardId', String(file.cardId));
      const newUrl = window.location.pathname + '?' + urlParams.toString();
      window.history.pushState({ cardId: file.cardId }, '', newUrl);
    }
    
    
    const pendingChange = pendingChanges.get(file.id);
    let content = '';
    
    if (pendingChange) {
      
      content = pendingChange.content;
    } else {
      
      if (file.type === 'card') {
        
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[file.nodeId || ''] || [];
        const card = nodeCards.find((c: Card) => c.docId === file.cardId);
        content = card?.content || '';
      }
      
      
      if (!originalContentsRef.current.has(file.id)) {
        originalContentsRef.current.set(file.id, content);
      }
    }
    
    startTransition(() => {
      if (pendingChangeToSave) {
        setPendingChanges(prev => {
          const newMap = new Map(prev);
          newMap.set(pendingChangeToSave!.file.id, {
            file: pendingChangeToSave!.file,
            content: pendingChangeToSave!.content,
            originalContent: pendingChangeToSave!.originalContent,
          });
          return newMap;
        });
      }
      setFileContent(content);
    });
  }, [base.nodes, selectedFile, editorInstance, fileContent, pendingChanges, isMultiSelectMode, fileTree, selectedItems]);

  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    
    if (cardId && fileTree.length > 0) {
      
      const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
      if (cardFile && (!selectedFile || selectedFile.id !== cardFile.id)) {
        
        
        handleSelectFile(cardFile, true);
      }
    }
  }, [fileTree, selectedFile, handleSelectFile]);

  
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const urlParams = new URLSearchParams(window.location.search);
      const cardId = urlParams.get('cardId');
      
      if (cardId && fileTree.length > 0) {
        
        const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
        if (cardFile && (!selectedFile || selectedFile.id !== cardFile.id)) {
          
          handleSelectFile(cardFile, true);
        }
      }
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [fileTree, selectedFile, handleSelectFile]);

  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    if (!cardId || base.nodes.length === 0) return;
    if (hasExpandedForCardIdRef.current === cardId) return;
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let nodeId: string | null = null;
    for (const nid of Object.keys(nodeCardsMap)) {
      const cards = (nodeCardsMap[nid] || []) as Array<{ docId?: string }>;
      if (cards.some((c) => c.docId === cardId)) {
        nodeId = nid;
        break;
      }
    }
    if (!nodeId) return;
    const collectAncestors = (id: string): string[] => {
      const edge = base.edges.find((e) => e.target === id);
      if (!edge) return [];
      return [edge.source, ...collectAncestors(edge.source)];
    };
    const toExpand = [nodeId, ...collectAncestors(nodeId)];
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      toExpand.forEach((id) => next.add(id));
      return next;
    });
    hasExpandedForCardIdRef.current = cardId;
  }, [base.nodes.length, base.edges]);

  
  useEffect(() => {
    if (!selectedFile || explorerMode !== 'tree') return;
    const id = selectedFile.id;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = explorerScrollRef.current;
        if (!container) return;
        const el = container.querySelector(`[data-file-id="${id}"]`);
        if (el) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedFile?.id, explorerMode]);

  
  const handleCreateSingleProblem = useCallback(async () => {
    if (!selectedFile || selectedFile.type !== 'card') {
      Notification.error(i18n('Please select a card on the left first'));
      return;
    }

    const stem = problemStem.trim();
    const options = problemOptions.map(opt => opt.trim()).filter(opt => opt.length > 0);
    const analysis = problemAnalysis.trim();

    if (!stem) {
      Notification.error(i18n('Stem cannot be empty'));
      return;
    }
    if (options.length < 2) {
      Notification.error('至少需要两个选项');
      return;
    }
    if (problemAnswer < 0 || problemAnswer >= options.length) {
      Notification.error(i18n('Please select the correct answer'));
      return;
    }

    try {
      setIsSavingProblem(true);

      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const nodeId = selectedFile.nodeId || '';
      const nodeCards: Card[] = nodeCardsMap[nodeId] || [];
      const card = nodeCards.find((c: Card) => c.docId === selectedFile.cardId);

      if (!card) {
        Notification.error('未找到对应的卡片数据，无法生成题目');
        return;
      }

      const existingProblems: CardProblem[] = card.problems || [];
      const newProblem: CardProblem = {
        pid: `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type: 'single',
        stem,
        options,
        answer: problemAnswer,
        analysis: analysis || undefined,
      };

      const updatedProblems = [...existingProblems, newProblem];

      
      if (nodeCardsMap[nodeId]) {
        const cardIndex = nodeCards.findIndex((c: Card) => c.docId === selectedFile.cardId);
        if (cardIndex >= 0) {
          nodeCards[cardIndex] = {
            ...nodeCards[cardIndex],
            problems: updatedProblems,
          };
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);

          
          if (!String(selectedFile.cardId || '').startsWith('temp-card-')) {
            const cardIdStr = String(selectedFile.cardId || '');
            setPendingProblemCardIds(prev => {
              const next = new Set(prev);
              next.add(cardIdStr);
              return next;
            });
            
            setPendingNewProblemCardIds(prev => {
              const next = new Set(prev);
              next.add(cardIdStr);
              return next;
            });
          }
        }
      }

      
      setProblemStem('');
      setProblemOptions(['', '', '', '']);
      setProblemAnswer(0);
      setProblemAnalysis('');

      Notification.success(i18n('Single choice generated and saved'));
    } catch (error: any) {
      Notification.error('生成单选题失败: ' + (error.message || '未知错误'));
    } finally {
      setIsSavingProblem(false);
    }
  }, [selectedFile, problemStem, problemOptions, problemAnswer, problemAnalysis]);


  const handleSaveAll = useCallback(async () => {
    if (isCommitting) {
      return;
    }
    
    setIsCommitting(true);

    
    let allChanges = new Map(pendingChanges);
    if (selectedFile && editorInstance) {
      try {
        const currentContent = editorInstance.value() || fileContent;
        const originalContent = originalContentsRef.current.get(selectedFile.id) || '';
        
        if (currentContent !== originalContent) {
          allChanges.set(selectedFile.id, {
            file: selectedFile,
            content: currentContent,
            originalContent: originalContent,
          });
        }
      } catch (error) {
      }
    }

    const hasContentChanges = allChanges.size > 0;
    const hasDragChanges = pendingDragChanges.size > 0;
    const hasRenameChanges = pendingRenames.size > 0;
    const hasCreateChanges = pendingCreatesRef.current.size > 0;
    const hasDeleteChanges = pendingDeletes.size > 0;
    const hasProblemChanges = pendingProblemCardIds.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0;
    
    
    const totalTasks =
      (hasContentChanges ? allChanges.size : 0) +
      (hasDragChanges ? pendingDragChanges.size : 0) +
      (hasRenameChanges ? pendingRenames.size : 0) +
      (hasCreateChanges ? pendingCreatesRef.current.size : 0) +
      (hasDeleteChanges ? pendingDeletes.size : 0) +
      (hasProblemChanges ? (pendingProblemCardIds.size + pendingNewProblemCardIds.size + pendingEditedProblemIds.size + pendingDeleteProblemIds.size) : 0);
    
    try {
      Notification.info(i18n('Saving...'));
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      
      const batchSaveData: any = {
        nodeCreates: [],
        nodeUpdates: [],
        nodeDeletes: [],
        cardCreates: [],
        cardUpdates: [],
        cardDeletes: [],
        edgeCreates: [],
        edgeDeletes: [],
      };
      
      const nodeIdMap = new Map<string, string>();
      const cardIdMap = new Map<string, string>();
      let createCountBeforeSave = 0;
      
      
      if (hasCreateChanges) {
        const creates = Array.from(pendingCreatesRef.current.entries()).map(([tempId, create]) => ({ tempId, ...create })).filter(c => 
          c.tempId && (c.tempId.startsWith('temp-node-') || c.tempId.startsWith('temp-card-'))
        );
        createCountBeforeSave = creates.length;
        
        
        const nodeCreates = creates.filter(c => c.type === 'node');
        const nodeIdSet = new Set<string>();
        
        for (const create of nodeCreates) {
          if (nodeIdSet.has(create.tempId)) {
            continue;
          }
          nodeIdSet.add(create.tempId);
          
          const renameRecord = pendingRenames.get(create.tempId);
          const nodeText = renameRecord ? renameRecord.newName : (create.text || i18n('New node'));
          
          
          batchSaveData.nodeCreates.push({
            tempId: create.tempId,
            text: nodeText,
            parentId: create.nodeId,
            x: create.x,
            y: create.y,
          });
        }
        
        
        const cardCreates = creates.filter(c => c.type === 'card');
        const cardIdSet = new Set<string>();
        
        for (const create of cardCreates) {
          if (cardIdSet.has(create.tempId)) {
            continue;
          }
          cardIdSet.add(create.tempId);
          
          const createNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
          let createNodeId = create.nodeId;
          
          if (!createNodeId) {
            continue;
          }
          
          
          
          let createNodeCards: Card[] = createNodeCardsMap[createNodeId] || [];
          if (createNodeCards.length === 0 && create.nodeId && create.nodeId.startsWith('temp-node-')) {
            createNodeCards = createNodeCardsMap[create.nodeId] || [];
          }
          const tempCard = createNodeCards.find((c: Card) => c.docId === create.tempId);

          
          const contentChange = allChanges.get(`card-${create.tempId}`);
          const finalContent = contentChange?.content ?? tempCard?.content ?? '';
          
          const cardRenameKey = `card-${create.tempId}`;
          const renameRecord = pendingRenames.get(cardRenameKey);
          const finalTitle = renameRecord ? renameRecord.newName : (create.title || tempCard?.title || i18n('New card'));
          const finalProblems = tempCard?.problems;

          
          batchSaveData.cardCreates.push({
            tempId: create.tempId,
            nodeId: createNodeId,
            title: finalTitle,
            content: finalContent,
            problems: finalProblems,
          });
        }
      }
      
      
      if (hasContentChanges) {
        
        
        const tempNodeKeysToRemove: string[] = [];
        for (const [key, change] of allChanges.entries()) {
          if (change.file.type === 'node') {
            const isTempNode = (key && key.startsWith('temp-node-')) ||
                              (change.file.id && change.file.id.startsWith('temp-node-')) ||
                              (change.file.nodeId && change.file.nodeId.startsWith('temp-node-'));
            if (isTempNode) {
              tempNodeKeysToRemove.push(key);
            }
          }
        }
        
        tempNodeKeysToRemove.forEach(key => {
          allChanges.delete(key);
        });
        
        const changes = Array.from(allChanges.values());
        
        for (const change of changes) {
          if (change.file.type === 'node') {
            const isTempNode = (change.file.id && change.file.id.startsWith('temp-node-')) ||
                              (change.file.nodeId && change.file.nodeId.startsWith('temp-node-'));
            if (isTempNode) {
              continue;
            }
            
            const nodeIdToUpdate = change.file.nodeId || change.file.id;
            if (!nodeIdToUpdate || nodeIdToUpdate.startsWith('temp-node-')) {
              continue;
            }
            
            batchSaveData.nodeUpdates.push({ nodeId: nodeIdToUpdate, text: change.content });
          } else if (change.file.type === 'card') {
            const cardNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
            const cardNodeId = change.file.nodeId || '';
            const cardNodeCards: Card[] = cardNodeCardsMap[cardNodeId] || [];
            const cardIndex = cardNodeCards.findIndex((c: Card) => c.docId === change.file.cardId);
            const card = cardIndex >= 0 ? cardNodeCards[cardIndex] : null;
            
            const problems = card?.problems?.filter(p => !pendingDeleteProblemIds.has(p.pid));

            
            if (!change.file.cardId || String(change.file.cardId).startsWith('temp-card-')) {
              continue;
            }

            
            batchSaveData.cardUpdates.push({
              cardId: change.file.cardId,
              nodeId: change.file.nodeId || '',
              content: change.content,
              title: card?.title,
              problems,
            });
          }
        }
      }

      
      if (hasProblemChanges) {
        
        const nodeCardsMapForProblems = (window as any).UiContext?.nodeCardsMap || {};
        
        const contentChangedCardIds = new Set<string>();
        for (const change of allChanges.values()) {
          if (change.file.type === 'card' && change.file.cardId) {
            contentChangedCardIds.add(String(change.file.cardId));
          }
        }

        
        const problemUpdates: Array<{ cardId: string; nodeId: string; problems: CardProblem[] }> = [];
        
        for (const problemCardId of Array.from(pendingProblemCardIds)) {
          
          if (String(problemCardId).startsWith('temp-card-')) continue;
          
          if (contentChangedCardIds.has(String(problemCardId))) continue;

          
          let foundNodeId: string | null = null;
          let foundCard: Card | null = null;
          for (const nodeId in nodeCardsMapForProblems) {
            const cards: Card[] = nodeCardsMapForProblems[nodeId] || [];
            const card = cards.find(c => c.docId === problemCardId);
            if (card) {
              foundNodeId = nodeId;
              foundCard = card;
              break;
            }
          }

          if (!foundNodeId || !foundCard) {
            continue;
          }

          
          const problemsToSave = (foundCard.problems || []).filter(p => !pendingDeleteProblemIds.has(p.pid));
          
          problemUpdates.push({
            cardId: problemCardId,
            nodeId: foundNodeId,
            problems: problemsToSave,
          });
        }
        
        
        for (const { cardId, nodeId, problems } of problemUpdates) {
          const existingUpdate = batchSaveData.cardUpdates.find((u: any) => u.cardId === cardId);
          if (existingUpdate) {
            existingUpdate.problems = problems;
          } else {
            batchSaveData.cardUpdates.push({
              cardId,
              nodeId,
              problems,
            });
          }
        }
        
      }
      
      
      if (hasDragChanges) {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        
        
        const nodeOrderUpdates = new Set<string>();
        const cardIdsToUpdateOrder = new Set<string>();
        const nodeEdgeUpdates = new Map<string, { newEdge: BaseEdge | null; oldEdges: BaseEdge[] }>();
        
        
        for (const cardId of pendingDragChanges) {
          if (cardId.startsWith('node-')) {
            
            const nodeId = cardId.replace('node-', '');
            nodeOrderUpdates.add(nodeId);
            
            
            const newEdges = base.edges.filter(e => e.target === nodeId);
            const newEdge = newEdges.length > 0 ? newEdges[0] : null;
            
            
            const oldEdges = base.edges.filter(
              (e: BaseEdge) => e.target === nodeId
            );
            
            nodeEdgeUpdates.set(nodeId, { newEdge, oldEdges });
          } else {
            
            cardIdsToUpdateOrder.add(cardId);
          }
        }
        
        
        let currentBase: BaseDoc | null = null;
        if (nodeEdgeUpdates.size > 0) {
          try {
            currentBase = await request.get(getBaseUrl('/data', docId));
          } catch (error: any) {
          }
        }
        
        
        for (const [nodeId, { newEdge, oldEdges: localOldEdges }] of nodeEdgeUpdates) {
          if (!newEdge) continue;
          
          try {
            
            const edgesToCheck = currentBase?.edges || localOldEdges;
            const oldEdges = edgesToCheck.filter(
              (e: BaseEdge) => e.target === nodeId
            );
            
            
            const edgeExists = oldEdges.some(
              (e: BaseEdge) => e.source === newEdge.source && e.target === newEdge.target
            );
            
            
            for (const oldEdge of oldEdges) {
              
              const isNewEdge = oldEdge.source === newEdge.source && oldEdge.target === newEdge.target;
              if (!isNewEdge && oldEdge.id) {
                
                if (oldEdge.id.startsWith('temp-') || oldEdge.id.startsWith('edge-')) {
                  continue;
                }
                
                
                if (!batchSaveData.edgeDeletes.includes(oldEdge.id)) {
                  batchSaveData.edgeDeletes.push(oldEdge.id);
                }
              }
            }
            
            
            if (!edgeExists) {
              batchSaveData.edgeCreates.push({
                source: newEdge.source,
                target: newEdge.target,
                label: newEdge.label,
              });
            }
          } catch (error: any) {
            // If update fails, try to create edge directly
            batchSaveData.edgeCreates.push({
              source: newEdge.source,
              target: newEdge.target,
              label: newEdge.label,
            });
          }
        }
        
        
        for (const nodeId of nodeOrderUpdates) {
          const node = base.nodes.find(n => n.id === nodeId);
          if (node && !node.id.startsWith('temp-node-')) {
            const existingUpdate = batchSaveData.nodeUpdates.find((u: any) => u.nodeId === nodeId);
            if (existingUpdate) {
              existingUpdate.order = node.order !== undefined ? node.order : 0;
            } else {
              batchSaveData.nodeUpdates.push({ 
                nodeId, 
                order: node.order !== undefined ? node.order : 0,
              });
            }
          }
        }
        
        
        for (const nodeId in nodeCardsMap) {
          const cards = nodeCardsMap[nodeId] || [];
          for (const card of cards) {
            
            if (String(card.docId).startsWith('temp-card-')) continue;
            
            if (cardIdsToUpdateOrder.has(card.docId) && card.order !== undefined && card.order !== null) {
              const existingUpdate = batchSaveData.cardUpdates.find((u: any) => u.cardId === card.docId);
              if (existingUpdate) {
                existingUpdate.order = card.order;
              } else {
                batchSaveData.cardUpdates.push({
                  cardId: card.docId,
                  nodeId: nodeId,
                  order: card.order,
                });
              }
            }
          }
        }
        
      }
      
      
      if (hasRenameChanges) {
        
        
        
        const renames = Array.from(pendingRenames.values());
        
        
        const updatedRenames = renames.map(rename => {
          if (rename.file.type === 'node') {
            const nodeId = rename.file.nodeId || rename.file.id;
            
            if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
              const realNodeId = nodeIdMap.get(nodeId)!;
              return {
                ...rename,
                file: {
                  ...rename.file,
                  id: realNodeId,
                  nodeId: realNodeId,
                },
              };
            }
          }
          return rename;
        });
        
        
        for (const rename of updatedRenames) {
          if (rename.file.type === 'node') {
            
            const nodeId = rename.file.nodeId || rename.file.id;
            if (!nodeId || nodeId.startsWith('temp-node-')) {
              continue;
            }
            
            
            const existingUpdate = batchSaveData.nodeUpdates.find((u: any) => u.nodeId === nodeId);
            if (existingUpdate) {
              existingUpdate.text = rename.newName;
            } else {
              batchSaveData.nodeUpdates.push({ nodeId, text: rename.newName });
            }
          } else if (rename.file.type === 'card') {
            
            if (!rename.file.cardId || String(rename.file.cardId).startsWith('temp-card-')) {
              continue;
            }
            
            
            const existingUpdate = batchSaveData.cardUpdates.find((u: any) => u.cardId === rename.file.cardId);
            if (existingUpdate) {
              existingUpdate.title = rename.newName;
            } else {
              batchSaveData.cardUpdates.push({ 
                cardId: rename.file.cardId, 
                nodeId: rename.file.nodeId || '',
                title: rename.newName,
              });
            }
          }
        }
        
      }

      const hasDeleteChanges = pendingDeletes.size > 0;
      
      
      if (hasDeleteChanges) {
        
        const deletes = Array.from(pendingDeletes.values());
        
        
        const cardDeletes = deletes.filter(d => d.type === 'card');
        const nodeDeletes = deletes.filter(d => d.type === 'node');
        
        
        const realCardDeletes = cardDeletes.filter(del => 
          del.id && !String(del.id).startsWith('temp-card-')
        );
        
        
        realCardDeletes.forEach(del => {
          batchSaveData.cardDeletes.push(del.id);
        });
        
        
        const realNodeDeletes = nodeDeletes.filter(del => 
          del.id && !String(del.id).startsWith('temp-node-')
        );
        
        if (realNodeDeletes.length > 0) {
          
          const nodeIdsToDelete = new Set(realNodeDeletes.map(del => del.id));
          
          
          const edgesToDelete = base.edges.filter(
            (e: BaseEdge) => nodeIdsToDelete.has(e.source) || nodeIdsToDelete.has(e.target)
          );
          
          
          edgesToDelete.forEach(edge => {
            if (edge.id && !edge.id.startsWith('temp-edge-')) {
              batchSaveData.edgeDeletes.push(edge.id);
            }
          });
          
          
          realNodeDeletes.forEach(del => {
            batchSaveData.nodeDeletes.push(del.id);
          });
        }
      }

      
      for (const [cardId, cardFace] of Object.entries(pendingCardFaceChanges)) {
        if (String(cardId).startsWith('temp-card-')) continue;
        const existing = batchSaveData.cardUpdates.find((u: any) => u.cardId === cardId);
        if (existing) {
          existing.cardFace = cardFace;
        } else {
          const nodeCardsMapForFace = (window as any).UiContext?.nodeCardsMap || {};
          let nodeId = '';
          let title = '';
          for (const nid of Object.keys(nodeCardsMapForFace)) {
            const card = (nodeCardsMapForFace[nid] || []).find((c: Card) => c.docId === cardId);
            if (card) { nodeId = nid; title = card.title; break; }
          }
          if (nodeId) batchSaveData.cardUpdates.push({ cardId, nodeId, title, cardFace });
        }
      }

      
      const hasAnyChanges = 
        batchSaveData.nodeCreates.length > 0 ||
        batchSaveData.nodeUpdates.length > 0 ||
        batchSaveData.nodeDeletes.length > 0 ||
        batchSaveData.cardCreates.length > 0 ||
        batchSaveData.cardUpdates.length > 0 ||
        batchSaveData.cardDeletes.length > 0 ||
        batchSaveData.edgeCreates.length > 0 ||
        batchSaveData.edgeDeletes.length > 0;
      
      if (hasAnyChanges) {
        
        try {
          const response = await request.post(getBaseUrl('/batch-save'), batchSaveData);
          
          if (response.success) {
            
            if (response.nodeIdMap) {
              Object.entries(response.nodeIdMap).forEach(([tempId, realId]) => {
                nodeIdMap.set(tempId, realId as string);
              });
            }
            
            if (response.cardIdMap) {
              Object.entries(response.cardIdMap).forEach(([tempId, realId]) => {
                cardIdMap.set(tempId, realId as string);
              });
            }
            
            
            if (response.nodeIdMap && Object.keys(response.nodeIdMap).length > 0) {
              setBase(prev => ({
                ...prev,
                nodes: prev.nodes.map(n => {
                  const realId = nodeIdMap.get(n.id);
                  return realId ? { ...n, id: realId } : n;
                }).filter(n => !n.id.startsWith('temp-node-')),
                edges: prev.edges.map(e => {
                  const realSource = nodeIdMap.get(e.source) || e.source;
                  const realTarget = nodeIdMap.get(e.target) || e.target;
                  return { ...e, source: realSource, target: realTarget };
                }).filter(e => 
                  !e.source.startsWith('temp-node-') && 
                  !e.target.startsWith('temp-node-') &&
                  !e.id.startsWith('temp-edge-')
                ),
              }));
            }
            
            
            if (cardIdMap.size > 0 || nodeIdMap.size > 0) {
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              const updatedNodeCardsMap: any = {};
              
              for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
                const realNodeId = nodeIdMap.get(nodeId) || nodeId;
                if (realNodeId && !realNodeId.startsWith('temp-node-')) {
                  const updatedCards = (cards as Card[])
                    .map((card: Card) => {
                      const realCardId = cardIdMap.get(String(card.docId)) || card.docId;
                      return { ...card, docId: realCardId, nodeId: realNodeId };
                    })
                    .filter((card: Card) => !String(card.docId).startsWith('temp-card-'));
                  
                  if (updatedCards.length > 0) {
                    updatedNodeCardsMap[realNodeId] = updatedCards;
                  }
                }
              }
              
              (window as any).UiContext.nodeCardsMap = updatedNodeCardsMap;
            }
            
            
            for (const cardUpdate of batchSaveData.cardUpdates) {
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              const cards = nodeCardsMap[cardUpdate.nodeId] || [];
              const cardIndex = cards.findIndex((c: Card) => c.docId === cardUpdate.cardId);
              if (cardIndex >= 0) {
                const next = { ...cards[cardIndex] };
                if (cardUpdate.content !== undefined) next.content = cardUpdate.content;
                if (cardUpdate.title !== undefined) next.title = cardUpdate.title;
                if (cardUpdate.problems !== undefined) next.problems = cardUpdate.problems;
                if (cardUpdate.order !== undefined) next.order = cardUpdate.order;
                cards[cardIndex] = next;
              }
            }
            
            
            for (const cardCreate of batchSaveData.cardCreates) {
              const realCardId = cardIdMap.get(cardCreate.tempId);
              const realNodeId = nodeIdMap.get(cardCreate.nodeId) || cardCreate.nodeId;
              
              if (realCardId && realNodeId && !realNodeId.startsWith('temp-node-')) {
                const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                if (!nodeCardsMap[realNodeId]) {
                  nodeCardsMap[realNodeId] = [];
                }
                
                
                const existingIndex = nodeCardsMap[realNodeId].findIndex((c: Card) => c.docId === realCardId);
                if (existingIndex >= 0) {
                  nodeCardsMap[realNodeId][existingIndex] = {
                    ...nodeCardsMap[realNodeId][existingIndex],
                    docId: realCardId,
                    nodeId: realNodeId,
                    title: cardCreate.title,
                    content: cardCreate.content,
                    problems: cardCreate.problems,
                  };
                } else {
                  nodeCardsMap[realNodeId].push({
                    docId: realCardId,
                    nodeId: realNodeId,
                    title: cardCreate.title,
                    content: cardCreate.content,
                    problems: cardCreate.problems,
                  } as Card);
                }
              }
            }
            
            (window as any).UiContext.nodeCardsMap = { ...(window as any).UiContext?.nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
            
            
            for (const nodeCreate of batchSaveData.nodeCreates) {
              pendingCreatesRef.current.delete(nodeCreate.tempId);
            }
            for (const cardCreate of batchSaveData.cardCreates) {
              pendingCreatesRef.current.delete(cardCreate.tempId);
            }
            setPendingCreatesCount(pendingCreatesRef.current.size);
            
            if (response.errors && response.errors.length > 0) {
              Notification.warning(`保存完成，但有 ${response.errors.length} 个错误`);
            }
          } else {
            throw new Error(response.errors?.join(', ') || i18n('Batch save failed'));
          }
        } catch (error: any) {
          throw error;
        }
      }

      
      
      
      let actualRenameCount = 0;
      if (hasRenameChanges && nodeIdMap.size > 0) {
        
        const renames = Array.from(pendingRenames.values());
        actualRenameCount = renames.filter(rename => {
          if (rename.file.type === 'node') {
            const nodeId = rename.file.nodeId || rename.file.id;
            
            if (nodeId && nodeId.startsWith('temp-node-') && nodeIdMap.has(nodeId)) {
              return false;
            }
          }
          return true;
        }).length;
      } else {
        actualRenameCount = hasRenameChanges ? pendingRenames.size : 0;
      }
      
      
      setPendingChanges(new Map());
      setPendingDragChanges(new Set());
      setPendingRenames(new Map());
      pendingCreatesRef.current.clear();
      setPendingCreatesCount(0);
      setPendingDeletes(new Map());
      setPendingCardFaceChanges(prev => {
        const next = { ...prev };
        batchSaveData.cardUpdates.forEach((u: any) => delete next[u.cardId]);
        return next;
      });
      const savedProblemCardIds = new Set<string>(pendingProblemCardIds);
      
      setPendingProblemCardIds(new Set());
      setPendingNewProblemCardIds(new Set());
      setPendingEditedProblemIds(new Map());
      setPendingDeleteProblemIds(new Map());
      
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const savedCardIds = new Set<string>();
      if (hasProblemChanges) {
        setNewProblemIds(new Set());
        setEditedProblemIds(new Set());
        
        for (const change of allChanges.values()) {
          if (change.file.type === 'card' && change.file.cardId) {
            savedCardIds.add(String(change.file.cardId));
          }
        }
      }
      
      
      const problemChangesCount = pendingNewProblemCardIds.size + pendingEditedProblemIds.size + pendingDeleteProblemIds.size;
      
      const totalChanges = (hasContentChanges ? allChanges.size : 0) 
        + (hasDragChanges ? pendingDragChanges.size : 0) 
        + actualRenameCount
        + createCountBeforeSave
        + (hasDeleteChanges ? pendingDeletes.size : 0)
        + problemChangesCount;
      
      Notification.success(`保存成功，共 ${totalChanges} 项更改`);
      
      if (hasCreateChanges || hasAnyChanges) {
        try {
          const response = await request.get(getBaseUrl('/data', docId));
          setBase(response);
        } catch (error) {
        }
        
        for (const cardId of Array.from(savedProblemCardIds)) {
          if (!String(cardId).startsWith('temp-card-')) {
            savedCardIds.add(String(cardId));
          }
        }
        
        for (const cardId of savedCardIds) {
          let foundCard: Card | null = null;
          for (const nodeId in nodeCardsMap) {
            const cards: Card[] = nodeCardsMap[nodeId] || [];
            const card = cards.find(c => c.docId === cardId);
            if (card) {
              foundCard = card;
              break;
            }
          }
          
          if (foundCard && foundCard.problems) {
            const originalProblems = new Map<string, CardProblem>();
            foundCard.problems.forEach(p => {
              originalProblems.set(p.pid, { ...p });
            });
            originalProblemsRef.current.set(String(cardId), originalProblems);
          }
        }
        
        
        setNodeCardsMapVersion(prev => prev + 1);
        setOriginalProblemsVersion(prev => prev + 1);
      }
      
      if (hasContentChanges) {
        const changes = Array.from(allChanges.values());
        changes.forEach(change => {
          originalContentsRef.current.set(change.file.id, change.content);
        });
      }
    } catch (error: any) {
      Notification.error(i18n('Save failed') + ': ' + (error.message || i18n('Unknown error')));
    } finally {
      setIsCommitting(false);
    }
  }, [pendingChanges, pendingDragChanges, pendingRenames, pendingDeletes, pendingCardFaceChanges, pendingProblemCardIds, pendingNewProblemCardIds, pendingEditedProblemIds, pendingDeleteProblemIds, selectedFile, editorInstance, fileContent, docId, getBaseUrl, base.edges, setNodeCardsMapVersion, setNewProblemIds, setEditedProblemIds, setOriginalProblemsVersion]);

  useEffect(() => {
    saveHandlerRef.current = handleSaveAll;
  }, [handleSaveAll]);

  
  const handleRename = useCallback((file: FileItem, newName: string) => {
    if (!newName.trim()) {
      Notification.error(i18n('Name cannot be empty'));
      return;
    }

    const trimmedName = newName.trim();
    
    if (trimmedName === file.name) {
      setPendingRenames(prev => {
        const next = new Map(prev);
        next.delete(file.id);
        return next;
      });
      setEditingFile(null);
      return;
    }
    
    
    if (file.type === 'node') {
      setBase(prev => ({
        ...prev,
        nodes: prev.nodes.map(n => 
          n.id === file.nodeId 
            ? { ...n, text: trimmedName }
            : n
        ),
      }));
    } else if (file.type === 'card') {
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === file.cardId);
        if (cardIndex >= 0) {
          cards[cardIndex] = { ...cards[cardIndex], title: trimmedName };
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    setPendingRenames(prev => {
      const next = new Map(prev);
      next.set(file.id, {
        file,
        newName: trimmedName,
        originalName: file.name,
      });
      return next;
    });
    
    setEditingFile(null);
  }, []);

  const handleStartRename = useCallback((file: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingFile(file);
    setEditingName(file.name);
  }, []);

  
  const handleCancelRename = useCallback(() => {
    setEditingFile(null);
    setEditingName('');
  }, []);

  
  const handleConfirmRename = useCallback(async () => {
    if (editingFile) {
      await handleRename(editingFile, editingName);
    }
  }, [editingFile, editingName, handleRename]);

  
  const handleNewCard = useCallback((nodeId: string) => {
    
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot create: node is in delete list'));
      setContextMenu(null);
      return;
    }
    
    
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error(i18n('Cannot create: node does not exist'));
      setContextMenu(null);
      return;
    }
    
    const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newCard: PendingCreate = {
      type: 'card',
      nodeId,
      title: i18n('New card'),
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newCard);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (!nodeCardsMap[nodeId]) {
      nodeCardsMap[nodeId] = [];
    }
    const maxOrder = nodeCardsMap[nodeId].length > 0 
      ? Math.max(...nodeCardsMap[nodeId].map((c: Card) => c.order || 0))
      : 0;
    
    const tempCard: Card = {
      docId: tempId,
      cid: 0,
      nodeId,
      title: i18n('New card'),
      content: '',
      order: maxOrder + 1,
      updateAt: new Date().toISOString(),
    } as Card;
    
    nodeCardsMap[nodeId].push(tempCard);
    nodeCardsMap[nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion(prev => prev + 1);
    
    setContextMenu(null);
  }, [pendingDeletes, base.nodes]);

  
  const doImportFromText = useCallback((nodeId: string, text: string) => {
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot import: node is in delete list'));
      return;
    }
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error('无法导入：节点不存在');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      Notification.info(i18n('Please paste or enter content to import'));
      return;
    }
    
    const blocks = trimmed.split(/\n\s*\n\s*---\s*\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (blocks.length === 0) {
      Notification.info(i18n('No valid content (use ## Title and --- to separate cards)'));
      return;
    }
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    if (!nodeCardsMap[nodeId]) nodeCardsMap[nodeId] = [];
    const maxOrder = nodeCardsMap[nodeId].length > 0
      ? Math.max(...nodeCardsMap[nodeId].map((c: Card) => c.order || 0))
      : 0;
    const newChanges = new Map<string, PendingChange>();
    let order = maxOrder;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const firstLineMatch = block.match(/^(#{1,6})\s+(.*?)(?:\n|$)/);
      let title: string;
      let content: string;
      if (firstLineMatch) {
        title = firstLineMatch[2].trim() || '未命名';
        const firstLine = block.split('\n')[0] || '';
        content = block.slice(firstLine.length).replace(/^\n+/, '').trim();
      } else {
        const firstLine = block.split('\n')[0] || '';
        title = firstLine.trim() || i18n('Unnamed');
        content = block.includes('\n') ? block.slice(firstLine.length).replace(/^\n+/, '').trim() : '';
      }
      order += 1;
      const tempId = `temp-card-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`;
      const newCard: PendingCreate = { type: 'card', nodeId, title, tempId };
      pendingCreatesRef.current.set(tempId, newCard);
      const tempCard: Card = {
        docId: tempId,
        cid: 0,
        nodeId,
        title,
        content,
        order,
        updateAt: new Date().toISOString(),
      } as Card;
      nodeCardsMap[nodeId].push(tempCard);
      const fileItem: FileItem = {
        type: 'card',
        id: `card-${tempId}`,
        name: title,
        nodeId,
        cardId: tempId,
        parentId: nodeId,
        level: 0,
      };
      newChanges.set(`card-${tempId}`, { file: fileItem, content, originalContent: '' });
    }
    setPendingCreatesCount(pendingCreatesRef.current.size);
    nodeCardsMap[nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
    (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
    setNodeCardsMapVersion(prev => prev + 1);
    setPendingChanges(prev => {
      const next = new Map(prev);
      newChanges.forEach((v, k) => next.set(k, v));
      return next;
    });
    Notification.success(`已导入 ${blocks.length} 个卡片，请保存以生效`);
  }, [pendingDeletes, base.nodes]);

  
  const handleOpenImportWindow = useCallback((nodeId: string) => {
    if (pendingDeletes.has(nodeId)) {
      Notification.error(i18n('Cannot import: node is in delete list'));
      setContextMenu(null);
      return;
    }
    const nodeExists = base.nodes.some(n => n.id === nodeId);
    if (!nodeExists && !nodeId.startsWith('temp-node-')) {
      Notification.error('无法导入：节点不存在');
      setContextMenu(null);
      return;
    }
    setImportWindow({ nodeId });
    setContextMenu(null);
  }, [pendingDeletes, base.nodes]);

  
  useEffect(() => {
    if (!cardFaceWindow) return;
    const timer = setTimeout(() => {
      const textarea = cardFaceEditorRef.current;
      if (!textarea) return;
      const $textarea = $(textarea);
      $textarea.val(cardFaceEditContent);
      $textarea.attr('data-markdown', 'true');
      try {
        const editor = new Editor($textarea, {
          value: cardFaceEditContent,
          onChange: (value: string) => setCardFaceEditContent(value),
        });
        cardFaceEditorInstanceRef.current = editor;
      } catch (e) {
        console.error('Failed to init card face editor:', e);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      if (cardFaceEditorInstanceRef.current) {
        try {
          cardFaceEditorInstanceRef.current.destroy();
        } catch (e) {
          console.warn('Error destroying card face editor:', e);
        }
        cardFaceEditorInstanceRef.current = null;
      }
    };
  }, [cardFaceWindow?.file?.id]);

  
  const handleNewChildNode = useCallback((parentNodeId: string) => {
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const childNodes = base.edges
      .filter(e => e.source === parentNodeId)
      .map(e => base.nodes.find(n => n.id === e.target))
      .filter(Boolean) as BaseNode[];
    const nodeCards = (nodeCardsMap[parentNodeId] || [])
      .filter((card: Card) => !card.nodeId || card.nodeId === parentNodeId);
    
    const maxNodeOrder = childNodes.length > 0
      ? Math.max(...childNodes.map(n => n.order || 0))
      : 0;
    const maxCardOrder = nodeCards.length > 0
      ? Math.max(...nodeCards.map((c: Card) => c.order || 0))
      : 0;
    const maxOrder = Math.max(maxNodeOrder, maxCardOrder);
    
    const newChildNode: PendingCreate = {
      type: 'node',
      nodeId: parentNodeId,
      text: i18n('New node'),
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newChildNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    
    const tempNode: BaseNode = {
      id: tempId,
      text: i18n('New node'),
      order: maxOrder + 1,
    };
    
    
    const newEdge: BaseEdge = {
      id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      source: parentNodeId,
      target: tempId,
    };
    
    
    setBase(prev => {
      const updated = {
        ...prev,
        nodes: [...prev.nodes, tempNode].map(n =>
          n.id === parentNodeId
            ? { ...n, expanded: true }
            : n
        ),
        edges: [...prev.edges, newEdge],
      };
      
      baseRef.current = updated;
      return updated;
    });
    
    
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (!newSet.has(parentNodeId)) {
        newSet.add(parentNodeId);
        
        expandedNodesRef.current = newSet;
        
        triggerExpandAutoSave();
      }
      return newSet;
    });
    
    setContextMenu(null);
  }, [triggerExpandAutoSave]);

  
  const handleNewRootNode = useCallback(() => {
    const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    
    const rootNodes = base.nodes.filter(node => 
      !base.edges.some(edge => edge.target === node.id)
    );
    const maxOrder = rootNodes.length > 0
      ? Math.max(...rootNodes.map(n => n.order || 0))
      : 0;
    
    const newRootNode: PendingCreate = {
      type: 'node',
      nodeId: '', // root has no parent
      text: i18n('New node'),
      tempId,
    };
    
    pendingCreatesRef.current.set(tempId, newRootNode);
    setPendingCreatesCount(pendingCreatesRef.current.size);
    
    
    const tempNode: BaseNode = {
      id: tempId,
      text: i18n('New node'),
      order: maxOrder + 1,
    };
    
    
    setBase(prev => {
      const updated = {
        ...prev,
        nodes: [...prev.nodes, tempNode],
      };
      baseRef.current = updated;
      return updated;
    });
    
    setEmptyAreaContextMenu(null);
  }, [base.nodes, base.edges]);

  
  const handleNewRootCard = useCallback(() => {
    
    const rootNodes = base.nodes.filter(node => 
      !base.edges.some(edge => edge.target === node.id)
    );
    
    let targetNodeId: string;
    
    if (rootNodes.length === 0) {
      
      const tempNodeId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newRootNode: PendingCreate = {
        type: 'node',
        nodeId: '', // root has no parent
        text: i18n('New node'),
        tempId: tempNodeId,
      };
      
      pendingCreatesRef.current.set(tempNodeId, newRootNode);
      setPendingCreatesCount(pendingCreatesRef.current.size);
      
      
      const tempNode: BaseNode = {
        id: tempNodeId,
        text: i18n('New node'),
        order: 0,
      };
      
      setBase(prev => {
        const updated = {
          ...prev,
          nodes: [...prev.nodes, tempNode],
        };
        baseRef.current = updated;
        return updated;
      });
      
      targetNodeId = tempNodeId;
    } else {
      
      targetNodeId = rootNodes[0].id;
    }
    
    
    handleNewCard(targetNodeId);
    setEmptyAreaContextMenu(null);
  }, [base.nodes, base.edges, handleNewCard]);

  
  const handleCopy = useCallback((file?: FileItem) => {
    let itemsToCopy: FileItem[] = [];
    
    
    if (isMultiSelectMode && selectedItems.size > 0 && !file) {
      
      itemsToCopy = fileTree.filter(f => selectedItems.has(f.id));
    } else if (file) {
      
      itemsToCopy = [file];
    } else {
      return;
    }
    
    if (itemsToCopy.length === 0) return;
    
    setClipboard({ type: 'copy', items: itemsToCopy });
    
    
    if (navigator.clipboard && navigator.clipboard.writeText && itemsToCopy.length === 1) {
      const firstItem = itemsToCopy[0];
      const reference = firstItem.type === 'node' 
        ? `ejunz://node/${firstItem.nodeId}`
        : `ejunz://card/${firstItem.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        
      });
    }
    
    setContextMenu(null);
  }, [isMultiSelectMode, selectedItems, fileTree]);

  
  const handleCopyContent = useCallback((file: FileItem) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let text = '';
    if (file.type === 'card' && file.cardId != null && file.nodeId != null) {
      const pendingChange = pendingChanges.get(file.id);
      if (pendingChange) {
        text = pendingChange.content;
      } else {
        const nodeCards = nodeCardsMap[file.nodeId] || [];
        const card = nodeCards.find((c: Card) => c.docId === file.cardId);
        text = card?.content || '';
      }
    } else if (file.type === 'node' && file.nodeId != null) {
      const deletedNodeIds = new Set(
        Array.from(pendingDeletes.values()).filter(d => d.type === 'node').map(d => d.id)
      );
      const deletedCardIds = new Set(
        Array.from(pendingDeletes.values()).filter(d => d.type === 'card').map(d => d.id)
      );
      const getChildNodeIds = (nodeId: string): string[] => {
        return base.edges
          .filter(e => e.source === nodeId)
          .map(e => base.nodes.find(n => n.id === e.target))
          .filter((n): n is BaseNode => n != null)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map(n => n.id);
      };
      const getNodeName = (nodeId: string): string => {
        const node = base.nodes.find(n => n.id === nodeId);
        return pendingRenames.get(nodeId)?.newName ?? node?.text ?? '';
      };
      const buildNodeContent = (nodeId: string, depth: number): string[] => {
        if (deletedNodeIds.has(nodeId)) return [];
        const parts: string[] = [];
        const cardHeading = '#'.repeat(Math.min(2 + depth, 6));
        const nodeCards = (nodeCardsMap[nodeId] || [])
          .filter((c: Card) => (!c.nodeId || c.nodeId === nodeId) && !deletedCardIds.has(c.docId))
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        for (const card of nodeCards) {
          const cardFileId = `card-${card.docId}`;
          const pendingChange = pendingChanges.get(cardFileId);
          const content = pendingChange ? pendingChange.content : (card.content || '');
          const title = pendingRenames.get(cardFileId)?.newName ?? card.title ?? '';
          const titleLine = title.trim() ? `${cardHeading} ${title.trim()}\n\n` : '';
          const block = titleLine + (content.trim() || '');
          if (block.trim()) parts.push(block.trim());
        }
        const childIds = getChildNodeIds(nodeId);
        for (const childId of childIds) {
          const childName = getNodeName(childId).trim();
          const nodeHeading = '#'.repeat(Math.min(2 + depth, 6));
          const childParts = buildNodeContent(childId, depth + 1);
          if (childParts.length > 0) {
            const nodeTitleLine = childName ? `${nodeHeading} ${childName}\n\n` : '';
            parts.push((nodeTitleLine + childParts.join('\n\n---\n\n')).trim());
          }
        }
        return parts;
      };
      const parts = buildNodeContent(file.nodeId, 0);
      text = parts.join('\n\n---\n\n');
    }
    if (text !== '' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        Notification.success(i18n('Content copied to clipboard'));
      }).catch(() => {
        Notification.error(i18n('Copy failed'));
      });
    } else if (text === '') {
      Notification.info(i18n('No content to copy'));
    } else {
      Notification.error('剪贴板不可用');
    }
    setContextMenu(null);
  }, [pendingChanges, pendingRenames, base, pendingDeletes]);

  
  const handleCut = useCallback((file?: FileItem) => {
    let itemsToCut: FileItem[] = [];
    
    
    if (isMultiSelectMode && selectedItems.size > 0 && !file) {
      
      itemsToCut = fileTree.filter(f => selectedItems.has(f.id));
    } else if (file) {
      
      itemsToCut = [file];
    } else {
      return;
    }
    
    if (itemsToCut.length === 0) return;
    
    setClipboard({ type: 'cut', items: itemsToCut });
    
    
    if (navigator.clipboard && navigator.clipboard.writeText && itemsToCut.length === 1) {
      const firstItem = itemsToCut[0];
      const reference = firstItem.type === 'node' 
        ? `ejunz://node/${firstItem.nodeId}`
        : `ejunz://card/${firstItem.cardId}`;
      navigator.clipboard.writeText(reference).catch(() => {
        
      });
    }
    
    setContextMenu(null);
  }, [isMultiSelectMode, selectedItems, fileTree]);

  
  const cleanupPendingForTempItem = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      const nodeId = file.nodeId || '';
      if (nodeId.startsWith('temp-node-')) {
        
        pendingCreatesRef.current.delete(nodeId);
        setPendingCreatesCount(pendingCreatesRef.current.size);
        
        
        setPendingChanges(prev => {
          const next = new Map(prev);
          next.delete(nodeId);
          return next;
        });
        
        
        setPendingRenames(prev => {
          const next = new Map(prev);
          next.delete(nodeId);
          return next;
        });
        
        
        setPendingDragChanges(prev => {
          const next = new Set(prev);
          next.delete(`node-${nodeId}`);
          return next;
        });
        
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const nodeCards = nodeCardsMap[nodeId] || [];
        for (const card of nodeCards) {
          const cardId = card.docId;
          if (cardId && cardId.startsWith('temp-card-')) {
            
            pendingCreatesRef.current.delete(cardId);
            setPendingCreatesCount(pendingCreatesRef.current.size);
            
            
            setPendingChanges(prev => {
              const next = new Map(prev);
              next.delete(`card-${cardId}`);
              return next;
            });
            
            
            setPendingRenames(prev => {
              const next = new Map(prev);
              next.delete(`card-${cardId}`);
              return next;
            });
            
            
            setPendingDragChanges(prev => {
              const next = new Set(prev);
              next.delete(cardId);
              return next;
            });
          }
        }
      }
    } else if (file.type === 'card') {
      const cardId = file.cardId || '';
      if (cardId.startsWith('temp-card-')) {
        
        pendingCreatesRef.current.delete(cardId);
        setPendingCreatesCount(pendingCreatesRef.current.size);
        
        
        setPendingChanges(prev => {
          const next = new Map(prev);
          next.delete(`card-${cardId}`);
          return next;
        });
        
        
        setPendingRenames(prev => {
          const next = new Map(prev);
          next.delete(`card-${cardId}`);
          return next;
        });
        
        
        setPendingDragChanges(prev => {
          const next = new Set(prev);
          next.delete(cardId);
          return next;
        });
      }
    }
  }, []);

  
  const handlePaste = useCallback((targetNodeId: string) => {
    if (!clipboard || clipboard.items.length === 0) return;

    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};

    
    for (const item of clipboard.items) {
      if (item.type === 'node') {
        const sourceNodeId = item.nodeId || '';
        const sourceNode = base.nodes.find(n => n.id === sourceNodeId);
        
        
        if (!sourceNode) {
          
          if (clipboard.type === 'cut') {
            setClipboard(null);
          }
          continue;
        }
      
      
      if (clipboard.type === 'cut' && sourceNodeId.startsWith('temp-node-')) {
        
        cleanupPendingForTempItem({ type: 'node', id: sourceNodeId, nodeId: sourceNodeId, name: sourceNode.text || '', level: 0 });
      }

      
      const nodesToCopy: BaseNode[] = [];
      const nodeIdMap = new Map<string, string>();
      let nodeCounter = 0;

      
      const collectNodes = (nodeId: string) => {
        const node = base.nodes.find(n => n.id === nodeId);
        if (!node) return;

        
        if (nodeIdMap.has(nodeId)) return;

        nodeCounter++;
        const newId = `temp-node-${Date.now()}-${nodeCounter}-${Math.random().toString(36).substr(2, 9)}`;
        nodeIdMap.set(nodeId, newId);

        const newNode: BaseNode = {
          ...node,
          id: newId,
          text: node.text,
          order: node.order,
        };
        nodesToCopy.push(newNode);

        
        const childEdges = base.edges.filter(e => e.source === nodeId);
        childEdges.forEach(edge => {
          collectNodes(edge.target);
        });
      };

      collectNodes(sourceNodeId);

      
      const updatedEdges: BaseEdge[] = [];
      
      
      
      base.edges.forEach(edge => {
        const newSource = nodeIdMap.get(edge.source);
        const newTarget = nodeIdMap.get(edge.target);
        
        
        if (newSource && newTarget) {
          updatedEdges.push({
            id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            source: newSource,
            target: newTarget,
          });
        }
      });

      
      const rootNewId = nodeIdMap.get(sourceNodeId);
      if (rootNewId) {
        
        const edgeExists = updatedEdges.some(e => e.source === targetNodeId && e.target === rootNewId);
        if (!edgeExists) {
          updatedEdges.push({
            id: `temp-edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            source: targetNodeId,
            target: rootNewId,
          });
        }
      }

      
      
      setBase(prev => {
        const existingNodeIds = new Set(prev.nodes.map(n => n.id));
        const newNodes = nodesToCopy.filter(n => !existingNodeIds.has(n.id));
        const existingEdgeKeys = new Set(prev.edges.map(e => `${e.source}-${e.target}`));
        const newEdges = updatedEdges.filter(e => !existingEdgeKeys.has(`${e.source}-${e.target}`));
        return {
          ...prev,
          nodes: [...prev.nodes, ...newNodes],
          edges: [...prev.edges, ...newEdges],
        };
      });

      
      nodesToCopy.forEach(newNode => {
        const oldNodeId = Array.from(nodeIdMap.entries()).find(([_, newId]) => newId === newNode.id)?.[0];
        if (oldNodeId && nodeCardsMap[oldNodeId]) {
          const cards = nodeCardsMap[oldNodeId];
          const newCards = cards.map((card: Card, index: number) => {
            const newCardId = `temp-card-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`;
            return {
              ...card,
              docId: newCardId,
              nodeId: newNode.id,
            };
          });

          if (!nodeCardsMap[newNode.id]) {
            nodeCardsMap[newNode.id] = [];
          }
          nodeCardsMap[newNode.id].push(...newCards);
          
          
          newCards.forEach(newCard => {
            if (!pendingCreatesRef.current.has(newCard.docId)) {
              pendingCreatesRef.current.set(newCard.docId, {
                type: 'card',
                nodeId: newNode.id,
                title: newCard.title || i18n('New card'),
                tempId: newCard.docId,
              });
              setPendingCreatesCount(pendingCreatesRef.current.size);
            }
          });
        }
      });
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };

      
      if (clipboard.type === 'cut') {
        
        
        if (sourceNodeId.startsWith('temp-node-')) {
          
          
          nodeIdMap.forEach((newId, oldId) => {
            
            const oldCards = nodeCardsMap[oldId] || [];
            oldCards.forEach((card: Card) => {
              if (card.docId && card.docId.startsWith('temp-card-')) {
                cleanupPendingForTempItem({ 
                  type: 'card', 
                  id: `card-${card.docId}`, 
                  cardId: card.docId, 
                  nodeId: oldId, 
                  name: card.title || '', 
                  level: 0 
                });
              }
            });
            
            if (nodeCardsMap[oldId]) {
              delete nodeCardsMap[oldId];
            }
          });
          
          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
          
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        } else {
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(sourceNodeId, {
              type: 'node',
              id: sourceNodeId,
            });
            return next;
          });

          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => !nodeIdMap.has(n.id)),
            edges: prev.edges.filter(e => !nodeIdMap.has(e.source) && !nodeIdMap.has(e.target)),
          }));
        }
      }

      
      
      
      nodesToCopy.forEach(newNode => {
        const oldNodeId = Array.from(nodeIdMap.entries()).find(([_, newId]) => newId === newNode.id)?.[0];
        if (oldNodeId) {
          
          if (!pendingCreatesRef.current.has(newNode.id)) {
            
            const originalParentEdge = base.edges.find(e => e.target === oldNodeId);
            let parentNodeId: string;
            
            if (originalParentEdge) {
              
              const newParentId = nodeIdMap.get(originalParentEdge.source);
              if (newParentId) {
                
                parentNodeId = newParentId;
              } else {
                
                parentNodeId = targetNodeId;
              }
            } else {
              
              parentNodeId = targetNodeId;
            }
            
            pendingCreatesRef.current.set(newNode.id, {
              type: 'node',
              nodeId: parentNodeId,
              text: newNode.text || i18n('New node'),
              tempId: newNode.id,
            });
            setPendingCreatesCount(pendingCreatesRef.current.size);
          }
        }
      });

      setNodeCardsMapVersion(prev => prev + 1);
      setExpandedNodes(prev => {
        const newSet = new Set(prev);
        if (!newSet.has(targetNodeId)) {
          newSet.add(targetNodeId);
          
          expandedNodesRef.current = newSet;
          
          setBase(prev => {
            const updated = {
              ...prev,
              nodes: prev.nodes.map(n =>
                n.id === targetNodeId
                  ? { ...n, expanded: true }
                  : n
              ),
            };
            
            baseRef.current = updated;
            return updated;
          });
          
          triggerExpandAutoSave();
        }
        return newSet;
      });

      } else if (item.type === 'card') {
        const sourceCardId = item.cardId || '';
        const sourceNodeId = item.nodeId || '';

        
        const sourceCards = nodeCardsMap[sourceNodeId] || [];
        const sourceCard = sourceCards.find((c: Card) => c.docId === sourceCardId);
        
        
        if (!sourceCard) {
          
          if (clipboard.type === 'cut') {
            setClipboard(null);
          }
          continue;
        }
      
      
      if (clipboard.type === 'cut' && sourceCardId.startsWith('temp-card-')) {
        
        cleanupPendingForTempItem({ 
          type: 'card', 
          id: `card-${sourceCardId}`, 
          cardId: sourceCardId, 
          nodeId: sourceNodeId, 
          name: sourceCard.title || '', 
          level: 0 
        });
      }

      const newCardId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const maxOrder = nodeCardsMap[targetNodeId]?.length > 0
        ? Math.max(...nodeCardsMap[targetNodeId].map((c: Card) => c.order || 0))
        : 0;

      const newCard: Card = {
        ...sourceCard,
        docId: newCardId,
        nodeId: targetNodeId,
        order: maxOrder + 1,
      };

      
      if (!nodeCardsMap[targetNodeId]) {
        nodeCardsMap[targetNodeId] = [];
      }
      
      const existingIndex = nodeCardsMap[targetNodeId].findIndex((c: Card) => c.docId === newCardId);
      if (existingIndex === -1) {
        nodeCardsMap[targetNodeId].push(newCard);
        nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      }

      
      if (clipboard.type === 'cut') {
        const sourceCards = nodeCardsMap[sourceNodeId] || [];
        const cardIndex = sourceCards.findIndex((c: Card) => c.docId === sourceCardId);
        if (cardIndex >= 0) {
          sourceCards.splice(cardIndex, 1);
          nodeCardsMap[sourceNodeId] = sourceCards;
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);

          
          
          if (!sourceCardId.startsWith('temp-card-')) {
            
            setPendingDeletes(prev => {
              const next = new Map(prev);
              next.set(sourceCardId, {
                type: 'card',
                id: sourceCardId,
                nodeId: sourceNodeId,
              });
              return next;
            });
          }
        }
      }

      
      
      if (!pendingCreatesRef.current.has(newCardId)) {
        pendingCreatesRef.current.set(newCardId, {
          type: 'card',
          nodeId: targetNodeId,
          title: newCard.title || i18n('New card'),
          tempId: newCardId,
        });
        setPendingCreatesCount(pendingCreatesRef.current.size);
      }

        setNodeCardsMapVersion(prev => prev + 1);
      }
    }

    
    if (clipboard.type === 'cut') {
      setClipboard(null);
    }

    setContextMenu(null);
  }, [clipboard, base, setBase, cleanupPendingForTempItem, triggerExpandAutoSave]);

  
  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const deltaX = resizeStartXRef.current - e.clientX;
      const newWidth = Math.max(200, Math.min(800, resizeStartWidthRef.current + deltaX));
      setChatPanelWidth(newWidth);
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  
  useEffect(() => {
    scrollToBottomIfNeeded();
  }, [chatMessages, scrollToBottomIfNeeded]);

  
  const getNodePath = useCallback((nodeId: string): string[] => {
    const path: string[] = [];
    const nodeMap = new Map<string, string>(); // parentId -> nodeId
    
    
    base.edges.forEach((edge) => {
      nodeMap.set(edge.target, edge.source);
    });
    
    
    let currentNodeId: string | undefined = nodeId;
    while (currentNodeId) {
      const node = base.nodes.find(n => n.id === currentNodeId);
      if (node) {
        path.unshift(node.text || i18n('Unnamed Node'));
      }
      currentNodeId = nodeMap.get(currentNodeId);
    }
    
    return path;
  }, [base]);

  
  const handleGenerateProblemWithAgent = useCallback(async (userPrompt?: string) => {
    if (!selectedFile || selectedFile.type !== 'card') {
      Notification.error(i18n('Please select a card on the left first'));
      return;
    }

    try {
      setIsGeneratingProblemWithAgent(true);

      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const nodeId = selectedFile.nodeId || '';
      const nodeCards: Card[] = nodeCardsMap[nodeId] || [];
      const card = nodeCards.find((c: Card) => c.docId === selectedFile.cardId);

      if (!card) {
        Notification.error('未找到对应的卡片数据，无法生成题目');
        return;
      }

      
      const nodePath = getNodePath(nodeId);
      const cardPath = [...nodePath, card.title || i18n('Unnamed Card')].join(' > ');

      
      const cardContext = `当前卡片信息：
- 卡片标题：${card.title || i18n('Unnamed Card')}
- 卡片ID：${card.docId}
- 卡片路径：${cardPath}
- 卡片内容：${card.content || i18n('(No content)')}
- 已有题目数量：${(card.problems || []).length}`;

      const domainId = (window as any).UiContext?.domainId || 'system';
      const prompt = userPrompt || problemStem.trim() || '请根据当前卡片的内容生成一道单选题';

      
      const systemPrompt = `你是一个题目生成助手，专门帮助用户根据卡片内容生成单选题。

【当前卡片上下文】
${cardContext}

【你的任务】
根据用户的要求和当前卡片的内容，生成一道单选题。题目应该：
1. 与卡片内容相关
2. 题干清晰明确
3. 提供4个选项（A、B、C、D）
4. 明确正确答案
5. 提供解析说明（可选）

【输出格式】
你需要以 JSON 格式回复，格式如下：
\`\`\`json
{
  "stem": "题干内容",
  "options": ["选项A", "选项B", "选项C", "选项D"],
  "answer": 0,
  "analysis": "解析说明（可选）"
}
\`\`\`

【重要规则】
1. 只输出 JSON 代码块（\`\`\`json ... \`\`\`）
2. 不要添加多余说明文字
3. answer 必须是 0、1、2 或 3 中的一个数字
4. options 数组必须包含4个选项

用户要求：${prompt}`;

      
      const response = await fetch(`/d/${domainId}/ai/chat?stream=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `${systemPrompt}\n\n用户要求：${prompt}`,
          history: [],
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: '请求失败' }));
        throw new Error(errorData.error || '请求失败');
      }

      const data = await response.json();
      let aiResponse = data.content || data.message || '';

      
      const jsonMatch = aiResponse.match(/```(?:json)?\n([\s\S]*?)\n```/);
      if (!jsonMatch) {
        
        try {
          const parsed = JSON.parse(aiResponse);
          if (parsed.stem && parsed.options && parsed.answer !== undefined) {
            
            const existingProblems: CardProblem[] = card.problems || [];
            const newProblem: CardProblem = {
              pid: `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
              type: 'single',
              stem: parsed.stem,
              options: parsed.options,
              answer: parsed.answer,
              analysis: parsed.analysis || undefined,
            };

            const updatedProblems = [...existingProblems, newProblem];

            
            if (nodeCardsMap[nodeId]) {
              const cardIndex = nodeCards.findIndex((c: Card) => c.docId === selectedFile.cardId);
              if (cardIndex >= 0) {
                nodeCards[cardIndex] = {
                  ...nodeCards[cardIndex],
                  problems: updatedProblems,
                };
                (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
                setNodeCardsMapVersion(prev => prev + 1);

                
                const cardIdStr = String(selectedFile.cardId || '');
                if (cardIdStr && !cardIdStr.startsWith('temp-card-')) {
                  setPendingProblemCardIds(prev => {
                    const next = new Set(prev);
                    next.add(cardIdStr);
                    return next;
                  });
                  
                  setPendingNewProblemCardIds(prev => {
                    const next = new Set(prev);
                    next.add(cardIdStr);
                    return next;
                  });
                }
              }
            }

            Notification.success('题目已通过Agent生成并保存');
            return;
          }
        } catch (e) {
          
        }
        throw new Error('AI返回的格式不正确，请重试');
      }

      const jsonContent = jsonMatch[1];
      const problemData = JSON.parse(jsonContent);

      if (!problemData.stem || !problemData.options || problemData.answer === undefined) {
        throw new Error('AI返回的题目数据不完整');
      }

      
      setProblemStem(problemData.stem);
      setProblemOptions(problemData.options);
      setProblemAnswer(problemData.answer);
      setProblemAnalysis(problemData.analysis || '');

      Notification.success('题目已生成，请检查并确认');
    } catch (error: any) {
      Notification.error('通过Agent生成题目失败: ' + (error.message || '未知错误'));
    } finally {
      setIsGeneratingProblemWithAgent(false);
    }
  }, [selectedFile, problemStem, getNodePath, setNodeCardsMapVersion, setPendingProblemCardIds, setPendingNewProblemCardIds]);

  
  const handleAIChatPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const textarea = e.currentTarget;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const currentText = chatInput;

    let reference: { type: 'node' | 'card'; id: string; name: string; path: string[] } | null = null;
    let shouldPreventDefault = false;

    
    if (clipboard && clipboard.type === 'copy' && clipboard.items.length > 0) {
      
      const firstItem = clipboard.items[0];
      if (firstItem.type === 'node') {
        const nodeId = firstItem.nodeId || '';
        const node = base.nodes.find(n => n.id === nodeId);
        if (node) {
          const path = getNodePath(nodeId);
          reference = {
            type: 'node',
            id: nodeId,
            name: node.text || i18n('Unnamed Node'),
            path,
          };
          shouldPreventDefault = true;
        }
      } else if (firstItem.type === 'card') {
        const cardId = firstItem.cardId || '';
        const nodeId = firstItem.nodeId || '';
        const cards = nodeCardsMap[nodeId] || [];
        const card = cards.find((c: Card) => c.docId === cardId);
        if (card) {
          const nodePath = getNodePath(nodeId);
          const cardPath = [...nodePath, card.title || i18n('Unnamed Card')];
          reference = {
            type: 'card',
            id: cardId,
            name: card.title || i18n('Unnamed Card'),
            path: cardPath,
          };
          shouldPreventDefault = true;
        }
      }
    }

    
    if (!reference) {
      try {
        const clipboardText = e.clipboardData.getData('text');
        if (clipboardText) {
          
          const nodeMatch = clipboardText.match(/^ejunz:\/\/node\/(.+)$/);
          const cardMatch = clipboardText.match(/^ejunz:\/\/card\/(.+)$/);
          
          if (nodeMatch) {
            const nodeId = nodeMatch[1];
            const node = base.nodes.find(n => n.id === nodeId);
            if (node) {
              const path = getNodePath(nodeId);
              reference = {
                type: 'node',
                id: nodeId,
                name: node.text || i18n('Unnamed Node'),
                path,
              };
              shouldPreventDefault = true;
            }
          } else if (cardMatch) {
            const cardId = cardMatch[1];
            
            for (const nodeId in nodeCardsMap) {
              const cards = nodeCardsMap[nodeId] || [];
              const card = cards.find((c: Card) => c.docId === cardId);
              if (card) {
                const nodePath = getNodePath(nodeId);
                const cardPath = [...nodePath, card.title || i18n('Unnamed Card')];
                reference = {
                  type: 'card',
                  id: cardId,
                  name: card.title || i18n('Unnamed Card'),
                  path: cardPath,
                };
                shouldPreventDefault = true;
                break;
              }
            }
          }
        }
      } catch (err) {
        
        console.warn('Failed to read clipboard:', err);
      }
    }

    if (reference && shouldPreventDefault) {
      e.preventDefault();
      
      const placeholder = `@${reference.name}`;
      const newText = 
        currentText.slice(0, selectionStart) + 
        placeholder + 
        currentText.slice(selectionEnd);
      
      
      setChatInputReferences(prev => {
        const newRefs = prev.map(ref => {
          
          if (ref.startIndex >= selectionStart) {
            return {
              ...ref,
              startIndex: ref.startIndex + placeholder.length,
              endIndex: ref.endIndex + placeholder.length,
            };
          }
          return ref;
        });
        
        
        newRefs.push({
          type: reference!.type,
          id: reference!.id,
          name: reference!.name,
          path: reference!.path,
          startIndex: selectionStart,
          endIndex: selectionStart + placeholder.length,
        });
        
        
        return newRefs.sort((a, b) => a.startIndex - b.startIndex);
      });
      
      setChatInput(newText);
      
      
      if (clipboard && clipboard.type === 'copy') {
        setClipboard(null);
      }
      
      
      setTimeout(() => {
        const newCursorPos = selectionStart + placeholder.length;
        textarea.setSelectionRange(newCursorPos, newCursorPos);
        textarea.focus();
      }, 0);
    }
  }, [clipboard, chatInput, base, getNodePath, setClipboard]);

  
  const convertBaseToText = useCallback((): string => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeMap = new Map<string, { node: BaseNode; children: string[] }>();
    const rootNodes: string[] = [];

    
    base.nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

    
    base.edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });

    
    base.nodes.forEach((node) => {
      const hasParent = base.edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });

    
    const buildNodeText = (nodeId: string, indent: number = 0): string => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return '';

      const { node, children } = nodeData;
      const indentStr = '  '.repeat(indent);
      const path = getNodePath(nodeId);
      const pathStr = path.join(' > ');
      let result = `${indentStr}- ${node.text || i18n('Unnamed Node')} (ID: ${node.id}, 路径: ${pathStr})\n`;

      
      const cards = nodeCardsMap[nodeId] || [];
      if (cards.length > 0) {
        cards.forEach((card: Card) => {
          const cardPath = [...path, card.title || i18n('Unnamed Card')].join(' > ');
          result += `${indentStr}  📄 ${card.title || i18n('Unnamed Card')} (ID: ${card.docId}, 路径: ${cardPath})\n`;
          if (card.content) {
            const contentPreview = card.content.length > 100 
              ? card.content.substring(0, 100) + '...' 
              : card.content;
            result += `${indentStr}    内容: ${contentPreview}\n`;
          }
        });
      }

      
      children.forEach((childId) => {
        result += buildNodeText(childId, indent + 1);
      });

      return result;
    };

    let text = '当前知识库结构：\n\n';
    rootNodes.forEach((rootId) => {
      text += buildNodeText(rootId, 0);
    });

    return text;
  }, [base, getNodePath]);

  
  const expandReferences = useCallback((message: string): string => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    let expandedMessage = message;
    
    
    const referencePattern = /@([^\s@]+)/g;
    const matches = Array.from(message.matchAll(referencePattern));
    
    
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const refName = match[1];
      const startIndex = match.index!;
      const endIndex = startIndex + match[0].length;
      
      
      const matchedNode = base.nodes.find(n => n.text === refName);
      if (matchedNode) {
        const path = getNodePath(matchedNode.id);
        const pathStr = path.join(' > ');
        const expandedRef = `@${refName} (节点ID: ${matchedNode.id}, 完整路径: ${pathStr})`;
        expandedMessage = expandedMessage.slice(0, startIndex) + expandedRef + expandedMessage.slice(endIndex);
        continue;
      }
      
      
      for (const nodeId in nodeCardsMap) {
        const cards = nodeCardsMap[nodeId] || [];
        const matchedCard = cards.find((c: Card) => c.title === refName);
        if (matchedCard) {
          const nodePath = getNodePath(nodeId);
          const cardPath = [...nodePath, matchedCard.title || i18n('Unnamed Card')].join(' > ');
          
          const fullContent = matchedCard.content || i18n('(No content)');
          const expandedRef = `@${refName} (卡片ID: ${matchedCard.docId}, 完整路径: ${cardPath}, 完整内容: ${fullContent})`;
          expandedMessage = expandedMessage.slice(0, startIndex) + expandedRef + expandedMessage.slice(endIndex);
          break;
        }
      }
    }
    
    return expandedMessage;
  }, [base, getNodePath]);

  
  const handleAIChatSend = useCallback(async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage = chatInput.trim();
    
    const references = chatInputReferences.map(ref => ({
      type: ref.type,
      id: ref.id,
      name: ref.name,
      path: ref.path,
    }));
    
    
    const expandedMessage = expandReferences(userMessage);
    setChatInput('');
    setChatInputReferences([]);
    setIsChatLoading(true);

    
    const historyBeforeNewMessage = chatMessages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => {
        
        let content = msg.content;
        
        if (!content && msg.role === 'assistant') {
          content = '已完成';
        }
        return {
          role: msg.role,
          content: content,
        };
      });
    
    console.log('发送给AI的历史记录（之前）:', historyBeforeNewMessage);
    
    
    let assistantMessageIndex: number;
    setChatMessages(prev => {
      const newMessages: Array<{ 
        role: 'user' | 'assistant' | 'operation'; 
        content: string; 
        references?: Array<{ type: 'node' | 'card'; id: string; name: string; path: string[] }>;
        operations?: any[];
        isExpanded?: boolean;
      }> = [
        ...prev, 
        { 
          role: 'user' as const, 
          content: userMessage,
          references: references.length > 0 ? references : undefined,
        }
      ];
      assistantMessageIndex = newMessages.length;
      newMessages.push({ role: 'assistant' as const, content: '' });
      return newMessages;
    });

    
    scrollToBottomIfNeeded();

    try {
      const domainId = (window as any).UiContext?.domainId || 'system';
      
      const history = historyBeforeNewMessage;

      
      const baseText = convertBaseToText();
      
      
      const finalUserMessage = expandedMessage;

      
      let currentCardContext = '';
      const currentCard = getSelectedCard();
      if (currentCard && selectedFile && selectedFile.type === 'card') {
        const nodePath = getNodePath(selectedFile.nodeId || '');
        const cardPath = [...nodePath, currentCard.title || i18n('Unnamed Card')].join(' > ');
        const problems = currentCard.problems || [];
        
        
        let problemsText = '';
        if (problems.length > 0) {
          problemsText = '\n- 已有题目列表：\n';
          problems.forEach((p: CardProblem, index: number) => {
            const optionsText = p.options.map((opt, oi) => 
              `  ${String.fromCharCode(65 + oi)}. ${opt}${oi === p.answer ? ' (正确答案)' : ''}`
            ).join('\n');
            problemsText += `\n  题目 ${index + 1} (ID: ${p.pid})：\n`;
            problemsText += `  - 题干：${p.stem}\n`;
            problemsText += `  - 选项：\n${optionsText}\n`;
            if (p.analysis) {
              problemsText += `  - 解析：${p.analysis}\n`;
            }
          });
        } else {
          problemsText = '\n- 已有题目列表：暂无题目';
        }
        
        currentCardContext = `
【当前显示的卡片信息】
- 卡片标题：${currentCard.title || i18n('Unnamed Card')}
- 卡片ID：${currentCard.docId}
- 卡片路径：${cardPath}
- 卡片内容：${currentCard.content || i18n('(No content)')}
- 已有题目数量：${problems.length}${problemsText}

**重要**：用户当前正在查看这个卡片，如果用户询问关于题目生成、编辑题目等问题，都是针对这个卡片的。生成新题目时，请避免与已有题目重复。`;
      }

      
      const systemPrompt = `你是一个知识库操作助手，专门帮助用户操作知识库。

【你的核心职责】
1. **创建节点**：根据用户需求创建新的节点
2. **创建卡片**：在指定节点下创建卡片
3. **移动节点**：将节点移动到新的位置
4. **重命名**：修改节点或卡片的名称
5. **修改内容**：修改卡片的内容（当用户要求修改、美化、格式化卡片内容时使用）
6. **删除**：删除不需要的节点或卡片
7. **生成题目**：根据卡片内容生成单选题（当用户要求生成题目时，应该针对当前显示的卡片）

【知识库结构说明】
${baseText}
${currentCardContext}

【操作格式】
你需要以 JSON 格式回复操作指令，格式如下：
\`\`\`json
{
  "operations": [
    {
      "type": "create_node",
      "parentId": "node_xxx",
      "text": "新节点名称"
    },
    {
      "type": "create_card",
      "nodeId": "node_xxx",
      "title": "卡片标题",
      "content": "卡片内容（可选）"
    },
    {
      "type": "move_node",
      "nodeId": "node_xxx",
      "targetParentId": "node_yyy"
    },
    {
      "type": "move_card",
      "cardId": "card_xxx",
      "targetNodeId": "node_yyy"
    },
    {
      "type": "rename_node",
      "nodeId": "node_xxx",
      "newText": "新名称"
    },
    {
      "type": "rename_card",
      "cardId": "card_xxx",
      "newTitle": "新标题"
    },
    {
      "type": "update_card_content",
      "cardId": "card_xxx",
      "newContent": "新的卡片内容"
    },
    {
      "type": "delete_node",
      "nodeId": "node_xxx"
    },
    {
      "type": "delete_card",
      "cardId": "card_xxx"
    },
    {
      "type": "create_problem",
      "cardId": "card_xxx",
      "stem": "题干内容",
      "options": ["选项A", "选项B", "选项C", "选项D"],
      "answer": 0,
      "analysis": "解析说明（可选）"
    }
  ]
}
\`\`\`

【重要规则】
1. 只输出 JSON 代码块（\`\`\`json ... \`\`\`）
2. 不要添加多余说明文字
3. 如果用户只是询问，不需要操作，则只回复文字说明，不要输出 JSON
4. **重要**：当用户要求"修改内容"、"美化格式"、"格式化"、"优化内容"等时，应该使用 \`update_card_content\` 操作修改卡片的内容（content），而不是使用 \`rename_card\` 修改标题（title）
5. 只有在用户明确要求修改标题/名称时，才使用 \`rename_card\` 或 \`rename_node\`
6. **移动节点时**：
   - 必须仔细查看知识库结构说明，根据节点名称和完整路径找到正确的节点ID
   - 如果用户说"移动到XX文件夹/节点下"，必须在结构说明中找到名称匹配的节点，使用其ID作为 \`targetParentId\`
   - **重要**：节点ID格式通常是 \`node_xxx\`（如 \`node_1_6\`），不是卡片ID（卡片ID是长字符串）
   - 如果用户说"移动文件夹"，指的是移动节点（文件夹就是节点）
   - 如果找不到匹配的节点，应该回复错误信息而不是执行操作
7. **移动卡片时**：如果用户要移动的是卡片（不是节点），必须使用 \`move_card\` 操作，而不是 \`move_node\`。卡片ID通常是一个长字符串（如 \`692f8ab7f62755451fb3ffa\`），节点ID通常是 \`node_xxx\` 格式。**重要**：如果用户引用了卡片（如 @卡片名），要移动的应该是卡片，使用 \`move_card\` 操作。

用户指令：`;

      
      if (chatWebSocketRef.current) {
        chatWebSocketRef.current.close();
        chatWebSocketRef.current = null;
      }

      
      const { default: WebSocket } = await import('../components/socket');
      const wsPrefix = (window as any).UiContext?.wsPrefix || '';
      const wsUrl = `/d/${domainId}/ai/chat-ws`;
      const sock = new WebSocket(wsPrefix + wsUrl, false, true);
      chatWebSocketRef.current = sock;

      let accumulatedContent = '';
      let streamFinished = false;

      
      sock.onmessage = (_, data: string) => {
        try {
          const msg = JSON.parse(data);
          
          if (msg.type === 'content') {
            accumulatedContent += msg.content;
            
            
            let displayContent = accumulatedContent;
            const jsonMatch = displayContent.match(/```(?:json)?\n([\s\S]*?)\n```/);
            if (jsonMatch) {
              
              displayContent = displayContent.replace(/```(?:json)?\n[\s\S]*?\n```/g, '').trim();
            }
            
            
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: displayContent || '正在思考...',
                };
              }
              return newMessages;
            });
            
            
            scrollToBottomIfNeeded();
          } else if (msg.type === 'done') {
            streamFinished = true;
            const finalContent = msg.content || accumulatedContent;
            
            
            const jsonMatch = finalContent.match(/```(?:json)?\n([\s\S]*?)\n```/);
            let textContent = finalContent.replace(/```(?:json)?\n[\s\S]*?\n```/g, '').trim();
            
            
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: textContent || '已完成',
                };
              }
              return newMessages;
            });
            
            
            scrollToBottomIfNeeded();
            
              
              if (jsonMatch) {
                try {
                  const operations = JSON.parse(jsonMatch[1]);
                  if (operations.operations && Array.isArray(operations.operations)) {
                    
                    console.log('AI 返回的操作:', operations.operations);
                    
                    
                    setChatMessages(prev => {
                      const newMessages = [...prev];
                      newMessages.push({
                        role: 'operation',
                        content: `执行 ${operations.operations.length} 个操作`,
                        operations: operations.operations,
                        isExpanded: false,
                      });
                      return newMessages;
                    });
                    
                    
                    if (executeAIOperationsRef.current) {
                      executeAIOperationsRef.current(operations.operations).then((result) => {
                        if (result.success) {
                          Notification.success('AI 已执行操作');
                        } else {
                          
                          const errorText = result.errors.join('\n');
                          setChatMessages(prev => {
                            const newMessages = [...prev];
                            
                            newMessages.push({
                              role: 'assistant',
                              content: `操作执行失败，错误信息如下：\n${errorText}\n\n请根据错误信息重新执行操作，确保使用正确的节点ID。`,
                            });
                            return newMessages;
                          });
                          
                          
                          scrollToBottomIfNeeded();
                        }
                      }).catch((err) => {
                        console.error('Failed to execute operations:', err);
                        const errorMsg = '执行操作失败: ' + (err.message || '未知错误');
                        Notification.error(errorMsg);
                        setChatMessages(prev => {
                          const newMessages = [...prev];
                          newMessages.push({
                            role: 'assistant',
                            content: `操作执行失败：${errorMsg}\n\n请重新执行操作。`,
                          });
                          return newMessages;
                        });
                      });
                    } else {
                      setTimeout(async () => {
                        if (executeAIOperationsRef.current) {
                          const result = await executeAIOperationsRef.current(operations.operations);
                          if (result.success) {
                            Notification.success('AI 已执行操作');
                          } else {
                            const errorText = result.errors.join('\n');
                            setChatMessages(prev => {
                              const newMessages = [...prev];
                              newMessages.push({
                                role: 'assistant',
                                content: `操作执行时出现错误：\n${errorText}\n\n请根据错误信息重新执行操作。`,
                              });
                              return newMessages;
                            });
                          }
                        }
                      }, 100);
                    }
                  }
                } catch (e) {
                  console.error('Failed to parse AI operations:', e);
                  Notification.error('解析 AI 操作失败: ' + (e.message || '未知错误'));
                }
              }
            
            
            if (chatWebSocketRef.current) {
              chatWebSocketRef.current.close();
              chatWebSocketRef.current = null;
            }
            setIsChatLoading(false);
          } else if (msg.type === 'error') {
            streamFinished = true;
            setChatMessages(prev => {
              const newMessages = [...prev];
              if (newMessages[assistantMessageIndex]) {
                newMessages[assistantMessageIndex] = {
                  role: 'assistant',
                  content: `错误: ${msg.error || '未知错误'}`,
                };
              }
              return newMessages;
            });
            Notification.error('AI 聊天失败: ' + (msg.error || '未知错误'));
            setIsChatLoading(false);
            
            
            if (chatWebSocketRef.current) {
              chatWebSocketRef.current.close();
              chatWebSocketRef.current = null;
            }
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      sock.onclose = () => {
        chatWebSocketRef.current = null;
        if (!streamFinished) {
          setIsChatLoading(false);
        }
      };

      sock.onopen = () => {
        
        sock.send(JSON.stringify({
          message: `${systemPrompt}\n\n用户指令：${finalUserMessage}`,
          history,
        }));
      };
    } catch (error: any) {
      setChatMessages(prev => {
        const newMessages = [...prev];
        if (newMessages[assistantMessageIndex]) {
          newMessages[assistantMessageIndex] = {
            role: 'assistant',
            content: `错误: ${error.message || '未知错误'}`,
          };
        }
        return newMessages;
      });
      Notification.error('AI 聊天失败: ' + (error.message || '未知错误'));
    } finally {
      setIsChatLoading(false);
    }
  }, [chatInput, isChatLoading, chatMessages, convertBaseToText, expandReferences]);

  
  const executeAIOperations = useCallback(async (operations: any[]): Promise<{ success: boolean; errors: string[] }> => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const errors: string[] = [];
    
    for (const op of operations) {
      try {
        if (op.type === 'create_node') {
          const tempId = `temp-node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newChildNode: PendingCreate = {
            type: 'node',
            nodeId: op.parentId || '',
            text: op.text || i18n('New node'),
            tempId,
          };
          
          pendingCreatesRef.current.set(tempId, newChildNode);
          setPendingCreatesCount(pendingCreatesRef.current.size);
          
          const tempNode: BaseNode = {
            id: tempId,
            text: op.text || i18n('New node'),
          };
          
          setBase(prev => ({
            ...prev,
            nodes: [...prev.nodes, tempNode],
            edges: op.parentId ? [...prev.edges, {
              id: `temp-edge-${Date.now()}`,
              source: op.parentId,
              target: tempId,
            }] : prev.edges,
          }));
          
          if (op.parentId) {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              if (!newSet.has(op.parentId)) {
                newSet.add(op.parentId);
                
                expandedNodesRef.current = newSet;
                
                setBase(prev => {
                  const updated = {
                    ...prev,
                    nodes: prev.nodes.map(n =>
                      n.id === op.parentId
                        ? { ...n, expanded: true }
                        : n
                    ),
                  };
                  
                  baseRef.current = updated;
                  return updated;
                });
                
                triggerExpandAutoSave();
              }
              return newSet;
            });
          }
        } else if (op.type === 'create_card') {
          const tempId = `temp-card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const newCard: PendingCreate = {
            type: 'card',
            nodeId: op.nodeId,
            title: op.title || i18n('New card'),
            tempId,
          };
          
          pendingCreatesRef.current.set(tempId, newCard);
          setPendingCreatesCount(pendingCreatesRef.current.size);
          
          if (!nodeCardsMap[op.nodeId]) {
            nodeCardsMap[op.nodeId] = [];
          }
          const maxOrder = nodeCardsMap[op.nodeId].length > 0 
            ? Math.max(...nodeCardsMap[op.nodeId].map((c: Card) => c.order || 0))
            : 0;
          
          const tempCard: Card = {
            docId: tempId,
            cid: 0,
            nodeId: op.nodeId,
            title: op.title || i18n('New card'),
            content: op.content || '',
            order: maxOrder + 1,
            updateAt: new Date().toISOString(),
          } as Card;
          
          nodeCardsMap[op.nodeId].push(tempCard);
          nodeCardsMap[op.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          setExpandedNodes(prev => new Set(prev).add(op.nodeId));
        } else if (op.type === 'move_node') {
          let nodeId = op.nodeId;
          const targetParentId = op.targetParentId;
          
          console.log('执行 move_node 操作:', { nodeId, targetParentId });
          console.log('所有可用节点:', base.nodes.map(n => ({ id: n.id, text: n.text })));
          
          
          let node = base.nodes.find(n => n.id === nodeId);
          
          
          if (!node) {
            const nodeByName = base.nodes.find(n => n.text === nodeId);
            if (nodeByName) {
              console.warn(`警告：nodeId "${nodeId}" 是节点名称，不是节点ID。应该使用节点ID "${nodeByName.id}"`);
              const errorMsg = `错误：nodeId "${nodeId}" 是节点名称，不是节点ID。请使用节点ID "${nodeByName.id}"`;
              Notification.error(errorMsg);
              errors.push(errorMsg);
              continue;
            }
          }
          
          
          if (!node) {
            console.log('nodeId 不是节点ID，可能是卡片ID:', nodeId);
            
            for (const nId in nodeCardsMap) {
              const cards = nodeCardsMap[nId] || [];
              const card = cards.find((c: Card) => c.docId === nodeId);
              if (card) {
                console.log('找到卡片，但使用了 move_node 操作，应该使用 move_card');
                const errorMsg = `检测到 ${nodeId} 是卡片ID，不是节点ID。移动卡片请使用 move_card 操作，而不是 move_node。`;
                Notification.error(errorMsg);
                errors.push(errorMsg);
                continue;
              }
            }
            console.error('节点不存在:', nodeId);
            console.log('所有节点ID:', base.nodes.map(n => ({ id: n.id, text: n.text })));
            const errorMsg = `节点 ${nodeId} 不存在。请检查节点ID是否正确。`;
            Notification.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }
          
          
          if (targetParentId) {
            const targetNode = base.nodes.find(n => n.id === targetParentId);
            
            
            if (!targetNode) {
              const targetNodeByName = base.nodes.find(n => n.text === targetParentId);
              if (targetNodeByName) {
                console.warn(`警告：targetParentId "${targetParentId}" 是节点名称，不是节点ID。应该使用节点ID "${targetNodeByName.id}"`);
                const errorMsg = `错误：targetParentId "${targetParentId}" 是节点名称，不是节点ID。请使用节点ID "${targetNodeByName.id}"`;
                Notification.error(errorMsg);
                errors.push(errorMsg);
                continue;
              }
              
              console.error('目标节点不存在:', targetParentId);
              console.log('所有节点ID:', base.nodes.map(n => ({ id: n.id, text: n.text })));
              const errorMsg = `目标节点 ${targetParentId} 不存在。请检查节点ID是否正确。`;
              Notification.error(errorMsg);
              errors.push(errorMsg);
              continue;
            }
            console.log('目标节点:', { id: targetNode.id, text: targetNode.text });
          } else {
            console.log('移动到根节点');
          }
          
          
          const isDescendant = (ancestorId: string, nodeId: string): boolean => {
            const children = base.edges
              .filter(e => e.source === ancestorId)
              .map(e => e.target);
            if (children.includes(nodeId)) return true;
            return children.some(childId => isDescendant(childId, nodeId));
          };
          
          if (targetParentId && isDescendant(nodeId, targetParentId)) {
            const errorMsg = '不能将节点移动到自己的子节点下';
            Notification.error(errorMsg);
            errors.push(errorMsg);
            continue;
          }
          
          
          const oldEdges = base.edges.filter(e => e.target === nodeId);
          const newEdges = base.edges.filter(e => !oldEdges.includes(e));
          
          
          if (targetParentId) {
            
            const existingEdge = newEdges.find(e => e.source === targetParentId && e.target === nodeId);
            if (!existingEdge) {
              newEdges.push({
                id: `edge-${targetParentId}-${nodeId}-${Date.now()}`,
                source: targetParentId,
                target: nodeId,
              });
            }
          }
          
          setBase(prev => ({
            ...prev,
            edges: newEdges,
          }));
          
          setPendingDragChanges(prev => new Set(prev).add(`node-${nodeId}`));
          
          
          if (targetParentId) {
            setExpandedNodes(prev => {
              const newSet = new Set(prev);
              if (!newSet.has(targetParentId)) {
                newSet.add(targetParentId);
                
                expandedNodesRef.current = newSet;
                
                setBase(prev => {
                  const updated = {
                    ...prev,
                    nodes: prev.nodes.map(n =>
                      n.id === targetParentId
                        ? { ...n, expanded: true }
                        : n
                    ),
                  };
                  
                  baseRef.current = updated;
                  return updated;
                });
                
                triggerExpandAutoSave();
              }
              return newSet;
            });
          }
          
          Notification.success(`节点已移动到 ${targetParentId ? '目标节点下' : '根节点'}`);
        } else if (op.type === 'move_card') {
          const cardId = op.cardId;
          const targetNodeId = op.targetNodeId;
          
          console.log('执行 move_card 操作:', { cardId, targetNodeId });
          
          
          const targetNode = base.nodes.find(n => n.id === targetNodeId);
          if (!targetNode) {
            console.error('目标节点不存在:', targetNodeId);
            console.log('所有节点ID:', base.nodes.map(n => ({ id: n.id, text: n.text })));
            Notification.error(`目标节点 ${targetNodeId} 不存在。请检查节点ID是否正确。`);
            continue;
          }
          
          
          let foundCard: Card | null = null;
          let sourceNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              sourceNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !sourceNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          
          if (sourceNodeId === targetNodeId) {
            Notification.error('卡片已经在目标节点下');
            continue;
          }
          
          
          const sourceCards = nodeCardsMap[sourceNodeId] || [];
          const cardIndex = sourceCards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            sourceCards.splice(cardIndex, 1);
            nodeCardsMap[sourceNodeId] = sourceCards;
          }
          
          
          if (!nodeCardsMap[targetNodeId]) {
            nodeCardsMap[targetNodeId] = [];
          }
          
          
          const maxOrder = nodeCardsMap[targetNodeId].length > 0
            ? Math.max(...nodeCardsMap[targetNodeId].map((c: Card) => c.order || 0))
            : 0;
          
          
          const updatedCard: Card = {
            ...foundCard,
            nodeId: targetNodeId,
            order: maxOrder + 1,
          };
          
          nodeCardsMap[targetNodeId].push(updatedCard);
          nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          
          
          setPendingDragChanges(prev => new Set(prev).add(cardId));
          
          
          setExpandedNodes(prev => {
            const newSet = new Set(prev);
            if (!newSet.has(targetNodeId)) {
              newSet.add(targetNodeId);
              
              expandedNodesRef.current = newSet;
              
              setBase(prev => {
                const updated = {
                  ...prev,
                  nodes: prev.nodes.map(n =>
                    n.id === targetNodeId
                      ? { ...n, expanded: true }
                      : n
                  ),
                };
                
                baseRef.current = updated;
                return updated;
              });
              
              triggerExpandAutoSave();
            }
            return newSet;
          });
          
          Notification.success(`卡片已移动到节点 ${targetNode.text} 下`);
        } else if (op.type === 'rename_node') {
          const nodeId = op.nodeId;
          const newText = op.newText;
          
          const node = base.nodes.find(n => n.id === nodeId);
          if (!node) {
            Notification.error(`节点 ${nodeId} 不存在`);
            continue;
          }
          
          
          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.map(n => 
              n.id === nodeId ? { ...n, text: newText } : n
            ),
          }));
          
          
          const fileItem: FileItem = {
            type: 'node',
            id: nodeId,
            name: node.text || i18n('Unnamed Node'),
            nodeId: nodeId,
            level: 0,
          };
          
          setPendingRenames(prev => {
            const next = new Map(prev);
            next.set(nodeId, {
              file: fileItem,
              newName: newText,
              originalName: node.text || i18n('Unnamed Node'),
            });
            return next;
          });
        } else if (op.type === 'rename_card') {
          const cardId = op.cardId;
          const newTitle = op.newTitle;
          
          
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = { ...cards[cardIndex], title: newTitle };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
          
          
          const fileItem: FileItem = {
            type: 'card',
            id: `card-${cardId}`,
            name: foundCard.title || i18n('Unnamed Card'),
            nodeId: foundNodeId,
            cardId: cardId,
            level: 0,
          };
          
          setPendingRenames(prev => {
            const next = new Map(prev);
            next.set(`card-${cardId}`, {
              file: fileItem,
              newName: newTitle,
              originalName: foundCard!.title || i18n('Unnamed Card'),
            });
            return next;
          });
        } else if (op.type === 'update_card_content') {
          const cardId = op.cardId;
          const newContent = op.newContent;
          
          
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;
          
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = { ...cards[cardIndex], content: newContent };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
          
          
          const fileItem: FileItem = {
            type: 'card',
            id: `card-${cardId}`,
            name: foundCard.title || i18n('Unnamed Card'),
            nodeId: foundNodeId,
            cardId: cardId,
            level: 0,
          };
          
          
          setPendingChanges(prev => {
            const next = new Map(prev);
            next.set(`card-${cardId}`, {
              file: fileItem,
              content: newContent,
              originalContent: foundCard!.content || '',
            });
            
            return new Map(next);
          });
          
          
          if (selectedFile && selectedFile.type === 'card' && selectedFile.cardId === cardId) {
            setFileContent(newContent);
            
            setTimeout(() => {
              
              if (editorRef.current) {
                editorRef.current.value = newContent;
                
                const event = new Event('input', { bubbles: true });
                editorRef.current.dispatchEvent(event);
              }
              
              if (editorInstance) {
                try {
                  editorInstance.value(newContent);
                } catch (e) {
                  
                }
              }
              
              const $textarea = $(`#editor-wrapper-${selectedFile.id} textarea`);
              if ($textarea.length > 0) {
                $textarea.val(newContent);
                
                if ($textarea.attr('data-markdown') === 'true') {
                  
                  $textarea.trigger('change');
                }
              }
            }, 100);
          }
        } else if (op.type === 'delete_node') {
          const nodeId = op.nodeId;
          const node = base.nodes.find(n => n.id === nodeId);
          if (!node) {
            Notification.error(`节点 ${nodeId} 不存在`);
            continue;
          }
          
          
          const hasCards = nodeCardsMap[nodeId]?.length > 0;
          const hasChildren = base.edges.some(e => e.source === nodeId);
          
          if (hasCards || hasChildren) {
            Notification.error(i18n('Cannot delete: node has children or cards'));
            continue;
          }
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(nodeId, {
              type: 'node',
              id: nodeId,
            });
            return next;
          });
          
          setBase(prev => ({
            ...prev,
            nodes: prev.nodes.filter(n => n.id !== nodeId),
            edges: prev.edges.filter(e => e.source !== nodeId && e.target !== nodeId),
          }));
        } else if (op.type === 'delete_card') {
          const cardId = op.cardId;
          
          
          let foundNodeId: string | null = null;
          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundNodeId = nodeId;
              break;
            }
          }
          
          if (!foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            continue;
          }
          
          setPendingDeletes(prev => {
            const next = new Map(prev);
            next.set(cardId, {
              type: 'card',
              id: cardId,
              nodeId: foundNodeId!,
            });
            return next;
          });
          
          const cards = nodeCardsMap[foundNodeId!];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards.splice(cardIndex, 1);
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else if (op.type === 'create_problem') {
          const cardId = op.cardId;
          const stem = op.stem;
          const options = op.options || [];
          const answer = op.answer;
          const analysis = op.analysis;

          if (!cardId) {
            Notification.error(i18n('cardId is required'));
            errors.push('create_problem 操作缺少 cardId');
            continue;
          }

          if (!stem) {
            Notification.error('题干是必需的');
            errors.push('create_problem 操作缺少 stem');
            continue;
          }

          if (!options || options.length < 2) {
            Notification.error('至少需要两个选项');
            errors.push('create_problem 操作的选项数量不足');
            continue;
          }

          if (answer === undefined || answer < 0 || answer >= options.length) {
            Notification.error(i18n('Answer index invalid'));
            errors.push('create_problem 操作的答案索引无效');
            continue;
          }

          
          let foundCard: Card | null = null;
          let foundNodeId: string | null = null;

          for (const nodeId in nodeCardsMap) {
            const cards = nodeCardsMap[nodeId] || [];
            const card = cards.find((c: Card) => c.docId === cardId);
            if (card) {
              foundCard = card;
              foundNodeId = nodeId;
              break;
            }
          }

          if (!foundCard || !foundNodeId) {
            Notification.error(`卡片 ${cardId} 不存在`);
            errors.push(`卡片 ${cardId} 不存在`);
            continue;
          }

          
          const existingProblems: CardProblem[] = foundCard.problems || [];
          const newProblem: CardProblem = {
            pid: `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'single',
            stem,
            options,
            answer,
            analysis: analysis || undefined,
          };

          const updatedProblems = [...existingProblems, newProblem];

          
          const cards = nodeCardsMap[foundNodeId];
          const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
          if (cardIndex >= 0) {
            cards[cardIndex] = {
              ...cards[cardIndex],
              problems: updatedProblems,
            };
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            setNodeCardsMapVersion(prev => prev + 1);

            
            
            const cardIdStr = String(cardId);
            if (cardIdStr && !cardIdStr.startsWith('temp-card-')) {
              setPendingProblemCardIds(prev => {
                const next = new Set(prev);
                next.add(cardIdStr);
                return next;
              });
              
              setPendingNewProblemCardIds(prev => {
                const next = new Set(prev);
                next.add(cardIdStr);
                return next;
              });
            }
          }

          Notification.success('题目已通过Agent生成并保存');
        }
      } catch (error: any) {
        console.error(`Failed to execute operation ${op.type}:`, error);
        const errorMsg = `执行操作失败: ${op.type} - ${error.message || '未知错误'}`;
        Notification.error(errorMsg);
        errors.push(errorMsg);
      }
    }
    
    return { success: errors.length === 0, errors };
  }, [base, setBase, selectedFile, editorInstance, setFileContent, triggerExpandAutoSave, setNodeCardsMapVersion, setPendingProblemCardIds]);

  
  useEffect(() => {
    executeAIOperationsRef.current = executeAIOperations;
  }, [executeAIOperations]);

  
  const getNodeChildren = useCallback((nodeId: string, visited: Set<string> = new Set()): { nodes: string[]; cards: string[] } => {
    if (visited.has(nodeId)) {
      return { nodes: [], cards: [] };
    }
    visited.add(nodeId);
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cards: string[] = (nodeCardsMap[nodeId] || []).map((c: Card) => c.docId || '').filter(Boolean);
    const childNodes: string[] = base.edges
      .filter(e => e.source === nodeId)
      .map(e => e.target)
      .filter(Boolean);
    
    
    const allNodes: string[] = [...childNodes];
    const allCards: string[] = [...cards];
    
    for (const childNodeId of childNodes) {
      const childData = getNodeChildren(childNodeId, visited);
      allNodes.push(...childData.nodes);
      allCards.push(...childData.cards);
    }
    
    return { nodes: allNodes, cards: allCards };
  }, [base.edges]);
  
  
  useEffect(() => {
    getNodeChildrenRef.current = getNodeChildren;
  }, [getNodeChildren]);

  
  const handleExportToPDF = useCallback(async (nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const node = base.nodes.find(n => n.id === nodeId);
    if (!node) {
      Notification.error(i18n('Node does not exist'));
      return;
    }

    
    const dialog = new Dialog({
      $body: `
        <div style="padding: 20px;">
          <div style="text-align: center; margin-bottom: 15px; font-size: 16px; font-weight: 500; color: #333;">
            正在导出PDF
          </div>
          <div id="pdf-export-status" style="text-align: center; margin-bottom: 10px; color: #666; font-size: 13px;">
            准备中...
          </div>
          <div class="bp5-progress-bar bp5-intent-primary bp5-no-stripes" style="margin-bottom: 10px;">
            <div id="pdf-export-progress" class="bp5-progress-meter" style="width: 0%; transition: width 0.3s ease;"></div>
          </div>
          <div id="pdf-export-current" style="text-align: center; color: #999; font-size: 12px; margin-top: 8px;">
          </div>
        </div>
      `,
    });

    const $status = dialog.$dom.find('#pdf-export-status');
    const $progress = dialog.$dom.find('#pdf-export-progress');
    const $current = dialog.$dom.find('#pdf-export-current');

    try {
      dialog.open();
      setContextMenu(null);

      
      $status.text(i18n('Loading PDF library...'));
      $progress.css('width', '10%');
      
      const [{ jsPDF }, html2canvasModule] = await Promise.all([
        import('jspdf'),
        import('html2canvas'),
      ]);
      
      $status.text(i18n('Collecting data...'));
      $progress.css('width', '20%');
      
      
      interface ExportItem {
        type: 'node' | 'card';
        id: string;
        title: string;
        content: string;
        level: number;
        order: number;
        parentOrder?: string;
      }

      const collectItems = (parentNodeId: string, level: number = 0, parentOrder: string = ''): ExportItem[] => {
        const items: ExportItem[] = [];
        
        
        const childNodes = base.edges
          .filter(e => e.source === parentNodeId)
          .map(e => {
            const childNode = base.nodes.find(n => n.id === e.target);
            return childNode ? { id: childNode.id, node: childNode, order: childNode.order || 0 } : null;
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;
        
        
        const cards = (nodeCardsMap[parentNodeId] || [])
          .filter((card: Card) => !card.nodeId || card.nodeId === parentNodeId)
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
        
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node })),
          ...cards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c })),
        ];
        
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        
        let itemIndex = 1;
        for (const child of allChildren) {
          const currentOrder = parentOrder ? `${parentOrder}.${itemIndex}` : `${itemIndex}`;
          
          if (child.type === 'node') {
            items.push({
              type: 'node',
              id: child.id,
              title: child.data.text || i18n('Unnamed Node'),
              content: '',
              level,
              order: child.order,
              parentOrder: currentOrder,
            });
            
            
            const childItems = collectItems(child.id, level + 1, currentOrder);
            items.push(...childItems);
          } else {
            
            let cardContent = child.data.content || '';
            const cardFileId = `card-${child.id}`;
            const pendingChange = pendingChanges.get(cardFileId);
            if (pendingChange) {
              cardContent = pendingChange.content;
            }
            
            items.push({
              type: 'card',
              id: child.id,
              title: child.data.title || i18n('Unnamed Card'),
              content: cardContent,
              level,
              order: child.order,
              parentOrder: currentOrder,
            });
          }
          
          itemIndex++;
        }
        
        return items;
      };

      const allItems = collectItems(nodeId, 0, '');
      const totalItems = allItems.length;
      
      $status.text(`共找到 ${totalItems} 个项目，开始生成PDF...`);
      $progress.css('width', '30%');
      
      
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const contentWidth = pageWidth - 2 * margin;
      let yPos = margin;
      const lineHeight = 7;
      const titleHeight = 10;
      const sectionSpacing = 5;

      
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      const rootTitle = String(node.text || i18n('Unnamed Node')).trim();
      if (rootTitle && !isNaN(margin) && !isNaN(yPos)) {
        pdf.text(rootTitle, margin, yPos);
        yPos += titleHeight + sectionSpacing;
      }

      
      const tocItems: Array<{ order: string; title: string; page: number }> = [];
      let contentYPos = margin;

      
      pdf.addPage();

      let processedCount = 0;
      for (const item of allItems) {
        processedCount++;
        const progressPercent = 30 + Math.round((processedCount / totalItems) * 50); // 30-80%
        $progress.css('width', `${progressPercent}%`);
        $status.text(`正在处理: ${item.parentOrder} ${item.title}`);
        $current.text(`${processedCount} / ${totalItems}`);
        
        const currentPageNumber = pdf.internal.getNumberOfPages();
        tocItems.push({
          order: item.parentOrder || '',
          title: item.title,
          page: currentPageNumber,
        });

        
        if (contentYPos > pageHeight - margin - 20) {
          pdf.addPage();
          contentYPos = margin;
        }

        
        pdf.setFontSize(12 + (3 - item.level) * 2);
        pdf.setFont('helvetica', 'bold');
        const titleText = `${item.parentOrder || ''} ${item.title || '未命名'}`.trim();
        if (titleText) {
          const titleLines = pdf.splitTextToSize(titleText, contentWidth);
          
          if (isNaN(contentYPos) || contentYPos < margin) {
            contentYPos = margin;
          }
          
          if (Array.isArray(titleLines)) {
            titleLines.forEach((line: string) => {
              if (contentYPos + lineHeight > pageHeight - margin) {
                pdf.addPage();
                contentYPos = margin;
              }
              const lineText = String(line || '').trim();
              if (lineText && !isNaN(margin) && !isNaN(contentYPos)) {
                pdf.text(lineText, margin, contentYPos);
                contentYPos += lineHeight + 2;
              }
            });
          } else {
            const singleLine = String(titleLines || '').trim();
            if (singleLine && !isNaN(margin) && !isNaN(contentYPos)) {
              pdf.text(singleLine, margin, contentYPos);
              contentYPos += lineHeight + 2;
            }
          }
        }

        
        if (item.type === 'card' && item.content) {
          try {
            $status.text(`正在渲染: ${item.title}`);
            
            const htmlContent = await fetch('/markdown', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                text: item.content,
                inline: false,
              }),
            }).then(res => res.text());
            
            if (htmlContent) {
              
              
              const tempDiv = document.createElement('div');
              tempDiv.style.width = `${contentWidth}mm`;
              tempDiv.style.padding = '10px';
              tempDiv.style.fontSize = '12px';
              tempDiv.style.lineHeight = '1.6';
              tempDiv.style.fontFamily = 'Arial, "Microsoft YaHei", "SimSun", sans-serif';
              tempDiv.style.color = '#000';
              tempDiv.style.backgroundColor = '#fff';
              tempDiv.style.position = 'absolute';
              tempDiv.style.left = '-9999px';
              tempDiv.style.top = '0';
              tempDiv.innerHTML = htmlContent;
              document.body.appendChild(tempDiv);
              
              
              await new Promise<void>((resolve) => {
                const images = tempDiv.querySelectorAll('img');
                if (images.length === 0) {
                  resolve();
                  return;
                }
                let loadedCount = 0;
                const totalImages = images.length;
                images.forEach((img) => {
                  if (img.complete) {
                    loadedCount++;
                    if (loadedCount === totalImages) resolve();
                  } else {
                    img.onload = () => {
                      loadedCount++;
                      if (loadedCount === totalImages) resolve();
                    };
                    img.onerror = () => {
                      loadedCount++;
                      if (loadedCount === totalImages) resolve();
                    };
                  }
                });
                setTimeout(() => resolve(), 5000);
              });
              
              
              const canvas = await html2canvasModule.default(tempDiv, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                width: contentWidth * 3.779527559,
              });
              
              
              document.body.removeChild(tempDiv);
              
              
              const imgWidth = contentWidth;
              const imgHeight = (canvas.height / canvas.width) * imgWidth;
              
              
              const maxHeightPerPage = pageHeight - 2 * margin;
              if (imgHeight > maxHeightPerPage) {
                
                const parts = Math.ceil(imgHeight / maxHeightPerPage);
                const partHeight = imgHeight / parts;
                
                for (let i = 0; i < parts; i++) {
                  
                  if (contentYPos > pageHeight - margin - 10) {
                    pdf.addPage();
                    contentYPos = margin;
                  }
                  
                  
                  const partCanvas = document.createElement('canvas');
                  partCanvas.width = canvas.width;
                  partCanvas.height = Math.ceil(canvas.height / parts);
                  const ctx = partCanvas.getContext('2d');
                  if (ctx) {
                    const sourceY = i * (canvas.height / parts);
                    const sourceHeight = canvas.height / parts;
                    
                    ctx.drawImage(
                      canvas,
                      0,
                      sourceY,
                      canvas.width,
                      sourceHeight,
                      0,
                      0,
                      canvas.width,
                      sourceHeight
                    );
                    
                    const partImgData = partCanvas.toDataURL('image/png');
                    pdf.addImage(partImgData, 'PNG', margin, contentYPos, imgWidth, partHeight);
                    contentYPos += partHeight;
                  }
                }
              } else {
                
                if (contentYPos + imgHeight > pageHeight - margin) {
                  pdf.addPage();
                  contentYPos = margin;
                }
                
                
                const imgData = canvas.toDataURL('image/png');
                pdf.addImage(imgData, 'PNG', margin, contentYPos, imgWidth, imgHeight);
                contentYPos += imgHeight;
              }
              
              contentYPos += sectionSpacing;
            }
          } catch (error) {
            console.error('渲染Markdown失败:', error);
            
            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'normal');
            
            
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = item.content;
            const textContent = tempDiv.textContent || tempDiv.innerText || item.content;
            const contentLines = pdf.splitTextToSize(textContent.substring(0, 1000), contentWidth);
            
            for (const line of contentLines) {
              if (contentYPos + lineHeight > pageHeight - margin) {
                pdf.addPage();
                contentYPos = margin;
              }
              const lineText = String(line || '').trim();
              if (lineText && !isNaN(margin) && !isNaN(contentYPos)) {
                pdf.text(lineText, margin, contentYPos);
                contentYPos += lineHeight;
              }
            }
            
            contentYPos += sectionSpacing;
          }
        }

        contentYPos += sectionSpacing;
      }

      $status.text('正在生成目录...');
      $progress.css('width', '85%');
      
      
      pdf.insertPage(1);
      let tocYPos = margin;

      
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      const tocRootTitle = String(node.text || i18n('Unnamed Node')).trim();
      if (tocRootTitle && !isNaN(margin) && !isNaN(tocYPos)) {
        pdf.text(tocRootTitle, margin, tocYPos);
        tocYPos += titleHeight + sectionSpacing;
      }

      
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      if (!isNaN(margin) && !isNaN(tocYPos)) {
        pdf.text('目录', margin, tocYPos);
        tocYPos += lineHeight + 2;
      }

      
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      for (const tocItem of tocItems) {
        if (tocYPos + lineHeight > pageHeight - margin) {
          pdf.addPage();
          tocYPos = margin;
        }
        
        const tocText = `${tocItem.order || ''} ${tocItem.title || '未命名'} ................ ${tocItem.page || 1}`;
        const tocTextStr = String(tocText).trim();
        if (tocTextStr && !isNaN(margin) && !isNaN(tocYPos)) {
          pdf.text(tocTextStr, margin, tocYPos);
          tocYPos += lineHeight;
        }
      }

      $status.text(i18n('Saving PDF...'));
      $progress.css('width', '95%');
      
      
      const fileName = `${node.text || i18n('Unnamed Node')}_${new Date().toISOString().split('T')[0]}.pdf`;
      pdf.save(fileName);
      
      $status.text(i18n('Export complete'));
      $progress.css('width', '100%');
      $current.text('');
      
      Notification.success(i18n('PDF export successful'));
      
      
      setTimeout(() => {
        dialog.close();
      }, 1000);
    } catch (error: any) {
      console.error('导出PDF失败:', error);
      $status.text(`${i18n('Export failed')}: ${error?.message || i18n('Unknown error')}`);
      $progress.css('width', '100%');
      $progress.css('background-color', '#dc3545');
      Notification.error(`导出PDF失败: ${error?.message || '未知错误'}`);
      
      
      setTimeout(() => {
        dialog.close();
      }, 3000);
    }
  }, [base.nodes, base.edges, pendingChanges]);

  
  const handleToggleSelect = useCallback((file: FileItem) => {
    if (!isMultiSelectMode) return;
    
    setSelectedItems(prev => {
      const next = new Set(prev);
      const isSelected = next.has(file.id);
      
      if (isSelected) {
        
        next.delete(file.id);
        
        
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const children = getNodeChildrenRef.current(file.nodeId || '');
          children.nodes.forEach(nodeId => {
            
            const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
            if (nodeFile) next.delete(nodeFile.id);
          });
          children.cards.forEach(cardId => {
            
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile) next.delete(cardFile.id);
          });
        }
      } else {
        
        next.add(file.id);
        
        
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const children = getNodeChildrenRef.current(file.nodeId || '');
          children.nodes.forEach(nodeId => {
            const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
            if (nodeFile) next.add(nodeFile.id);
          });
          children.cards.forEach(cardId => {
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile) next.add(cardFile.id);
          });
        }
      }
      
      return next;
    });
  }, [isMultiSelectMode, fileTree]);

  
  const handleBatchDelete = useCallback(() => {
    if (selectedItems.size === 0) {
      Notification.info(i18n('Please select items to delete first'));
      return;
    }
    
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const itemsToDelete: FileItem[] = [];
    const allNodeIdsToDelete = new Set<string>();
    const allCardIdsToDelete = new Set<string>();
    
    
    for (const fileId of selectedItems) {
      const file = fileTree.find(f => f.id === fileId);
      if (file) {
        itemsToDelete.push(file);
        
        
        if (file.type === 'node' && getNodeChildrenRef.current) {
          const nodeId = file.nodeId || '';
          const children = getNodeChildrenRef.current(nodeId);
          children.nodes.forEach(childNodeId => {
            allNodeIdsToDelete.add(childNodeId);
            
            const childFile = fileTree.find(f => f.type === 'node' && f.nodeId === childNodeId);
            if (childFile && !itemsToDelete.find(f => f.id === childFile.id)) {
              itemsToDelete.push(childFile);
            }
          });
          children.cards.forEach(cardId => {
            allCardIdsToDelete.add(cardId);
            
            const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
            if (cardFile && !itemsToDelete.find(f => f.id === cardFile.id)) {
              itemsToDelete.push(cardFile);
            }
          });
        }
        
        
        if (file.type === 'node') {
          allNodeIdsToDelete.add(file.nodeId || '');
        } else if (file.type === 'card') {
          allCardIdsToDelete.add(file.cardId || '');
        }
      }
    }
    
    
    const tempNodeIds: string[] = [];
    const tempCardIds: string[] = [];
    
    for (const file of itemsToDelete) {
      if (file.type === 'node') {
        const nodeId = file.nodeId || '';
        if (nodeId.startsWith('temp-node-')) {
          cleanupPendingForTempItem(file);
          tempNodeIds.push(nodeId);
        }
      } else if (file.type === 'card') {
        const cardId = file.cardId || '';
        if (cardId.startsWith('temp-card-')) {
          cleanupPendingForTempItem(file);
          tempCardIds.push(cardId);
        }
      }
    }
    
    
    setPendingDeletes(prev => {
      const next = new Map(prev);
      
      
      for (const nodeId of allNodeIdsToDelete) {
        if (!tempNodeIds.includes(nodeId)) {
          next.set(nodeId, {
            type: 'node',
            id: nodeId,
          });
        }
      }
      
      
      for (const cardId of allCardIdsToDelete) {
        if (!tempCardIds.includes(cardId)) {
          
          const cardFile = itemsToDelete.find(f => f.type === 'card' && f.cardId === cardId);
          const cardNodeId = cardFile?.nodeId || 
            base.nodes.find(n => {
              const cards = nodeCardsMap[n.id] || [];
              return cards.some((c: Card) => c.docId === cardId);
            })?.id;
          
          next.set(cardId, {
            type: 'card',
            id: cardId,
            nodeId: cardNodeId,
          });
        }
      }
      
      return next;
    });
    
    
    const nodeIdsArray = Array.from(allNodeIdsToDelete);
    if (nodeIdsArray.length > 0) {
      setBase(prev => ({
        ...prev,
        nodes: prev.nodes.filter(n => !nodeIdsArray.includes(n.id)),
        edges: prev.edges.filter(e => 
          !nodeIdsArray.includes(e.source) && !nodeIdsArray.includes(e.target)
        ),
      }));
    }
    
    
    const cardIdsArray = Array.from(allCardIdsToDelete);
    for (const cardId of cardIdsArray) {
      
      for (const nodeIdKey in nodeCardsMap) {
        const cards = nodeCardsMap[nodeIdKey];
        const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
          break;
        }
      }
    }
    
    
    setSelectedItems(new Set());
    const totalItemsToDelete = allNodeIdsToDelete.size + allCardIdsToDelete.size;
    Notification.success(`已标记 ${totalItemsToDelete} 个项目待删除（包括 ${allNodeIdsToDelete.size} 个节点和 ${allCardIdsToDelete.size} 个卡片），请保存以确认删除`);
  }, [selectedItems, fileTree, cleanupPendingForTempItem]);

  
  const handleDelete = useCallback((file: FileItem) => {
    if (file.type === 'node') {
      
      const nodeId = file.nodeId || file.id || '';
      
      if (!nodeId) {
        Notification.error(i18n('Cannot delete: invalid node ID'));
        setContextMenu(null);
        return;
      }
      
      
      if (pendingDeletes.has(nodeId)) {
        Notification.info(i18n('Node already in delete list'));
        setContextMenu(null);
        return;
      }
      
      
      const isTempNode = nodeId.startsWith('temp-node-');
      
      if (isTempNode) {
        cleanupPendingForTempItem(file);
        
      } else {
        
        const children = getNodeChildrenRef.current ? getNodeChildrenRef.current(nodeId) : { nodes: [], cards: [] };
        
        
        setPendingDeletes(prev => {
          const next = new Map(prev);
          
          
          for (const childNodeId of children.nodes) {
            if (!next.has(childNodeId)) {
              next.set(childNodeId, {
                type: 'node',
                id: childNodeId,
              });
            }
          }
          
          
          for (const cardId of children.cards) {
            if (!next.has(cardId)) {
              
              const cardNodeId = base.nodes.find(n => {
                const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                const cards = nodeCardsMap[n.id] || [];
                return cards.some((c: Card) => c.docId === cardId);
              })?.id;
              
              next.set(cardId, {
                type: 'card',
                id: cardId,
                nodeId: cardNodeId,
              });
            }
          }
          
          
          next.set(nodeId, {
            type: 'node',
            id: nodeId,
          });
          
          return next;
        });
        
        
        const allNodeIdsToDelete = [nodeId, ...children.nodes];
        setBase(prev => ({
          ...prev,
          nodes: prev.nodes.filter(n => !allNodeIdsToDelete.includes(n.id)),
          edges: prev.edges.filter(e => 
            !allNodeIdsToDelete.includes(e.source) && !allNodeIdsToDelete.includes(e.target)
          ),
        }));
        
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        for (const cardId of children.cards) {
          
          for (const nodeIdKey in nodeCardsMap) {
            const cards = nodeCardsMap[nodeIdKey];
            const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
            if (cardIndex >= 0) {
              cards.splice(cardIndex, 1);
              (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              setNodeCardsMapVersion(prev => prev + 1);
              break;
            }
          }
        }
      }
    } else if (file.type === 'card') {
      const cardId = file.cardId || '';
      
      
      if (cardId.startsWith('temp-card-')) {
        cleanupPendingForTempItem(file);
        
      } else {
        
      setPendingDeletes(prev => {
        const next = new Map(prev);
          next.set(cardId, {
          type: 'card',
            id: cardId,
          nodeId: file.nodeId,
        });
        return next;
      });
      }
      
      
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      if (nodeCardsMap[file.nodeId || '']) {
        const cards = nodeCardsMap[file.nodeId || ''];
        const cardIndex = cards.findIndex((c: Card) => c.docId === cardId);
        if (cardIndex >= 0) {
          cards.splice(cardIndex, 1);
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          setNodeCardsMapVersion(prev => prev + 1);
        }
      }
    }
    
    setContextMenu(null);
  }, [base.edges, base.nodes, pendingDeletes, cleanupPendingForTempItem]);

  const getDropPositionForTouch = useCallback((
    dragged: FileItem,
    target: FileItem,
    clientY: number,
    targetRect: DOMRect,
    edges: typeof base.edges
  ): 'before' | 'after' | 'into' => {
    const midY = targetRect.top + targetRect.height / 2;
    if (dragged.type === 'card') {
      if (target.type === 'node') return 'into';
      if (target.type === 'card') return clientY < midY ? 'before' : 'after';
    }
    if (dragged.type === 'node' && target.type === 'node') {
      const draggedNodeId = dragged.nodeId || '';
      const targetNodeId = target.nodeId || '';
      const draggedParentEdge = edges.find(e => e.target === draggedNodeId);
      const targetParentEdge = edges.find(e => e.target === targetNodeId);
      const draggedParentId = draggedParentEdge?.source;
      const targetParentId = targetParentEdge?.source;
      if (draggedParentId && targetParentId && draggedParentId === targetParentId && draggedNodeId !== targetNodeId) {
        return clientY < midY ? 'before' : 'after';
      }
      return 'into';
    }
    return 'after';
  }, []);

  
  const handleDragStart = useCallback((e: React.DragEvent, file: FileItem) => {
    setDraggedFile(file);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', file.id);
  }, []);

  
  const handleDragEnd = useCallback(() => {
    
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
      dragLeaveTimeoutRef.current = null;
    }
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    
    setDraggedFile(null);
    setDragOverFile(null);
    setDropPosition('after');
    lastDragOverFileRef.current = null;
    lastDropPositionRef.current = 'after';
  }, []);

  
  const handleDragOver = useCallback((e: React.DragEvent, file: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    
    
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
      dragLeaveTimeoutRef.current = null;
    }
    
    if (!draggedFile || draggedFile.id === file.id) {
      
      if (lastDragOverFileRef.current?.id === file.id) {
        return;
      }
      
      if (dragOverTimeoutRef.current) {
        clearTimeout(dragOverTimeoutRef.current);
      }
      dragOverTimeoutRef.current = setTimeout(() => {
        if (lastDragOverFileRef.current?.id !== file.id) {
          setDragOverFile(null);
          lastDragOverFileRef.current = null;
        }
      }, 100);
      return;
    }
    
    
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseY = e.clientY;
    const newDropPosition = getDropPositionForTouch(draggedFile, file, mouseY, rect, base.edges);
    if (lastDragOverFileRef.current?.id === file.id) {
      if (lastDropPositionRef.current !== newDropPosition) {
        setDropPosition(newDropPosition);
        lastDropPositionRef.current = newDropPosition;
      }
      return;
    }
    
    
    if (dragOverTimeoutRef.current) {
      clearTimeout(dragOverTimeoutRef.current);
      dragOverTimeoutRef.current = null;
    }
    
    
    setDragOverFile(file);
    setDropPosition(newDropPosition);
    lastDragOverFileRef.current = file;
    lastDropPositionRef.current = newDropPosition;
  }, [draggedFile, base.edges, getDropPositionForTouch]);

  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    
    if (dragLeaveTimeoutRef.current) {
      clearTimeout(dragLeaveTimeoutRef.current);
    }
    
    
    dragLeaveTimeoutRef.current = setTimeout(() => {
      setDragOverFile(null);
      dragLeaveTimeoutRef.current = null;
    }, 50);
  }, []);

  
  const handleDrop = useCallback((e: React.DragEvent, targetFile: FileItem, positionOverride?: 'before' | 'after' | 'into') => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedFile || draggedFile.id === targetFile.id) {
      setDragOverFile(null);
      return;
    }

    const effectivePosition = positionOverride ?? dropPosition;

    try {
      
      if (draggedFile.type === 'card' && targetFile.type === 'node') {
        
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const targetNodeCards = nodeCardsMap[targetFile.nodeId] || [];
        const maxOrder = targetNodeCards.length > 0 
          ? Math.max(...targetNodeCards.map((c: Card) => c.order || 0))
          : 0;
        const newOrder = maxOrder + 1;
        
        
        if (nodeCardsMap[draggedFile.nodeId || '']) {
          const cards = nodeCardsMap[draggedFile.nodeId || ''];
          const cardIndex = cards.findIndex((c: Card) => c.docId === draggedFile.cardId);
          if (cardIndex >= 0) {
            const [card] = cards.splice(cardIndex, 1);
            
            card.nodeId = targetFile.nodeId || '';
            card.order = newOrder;
            
            
            if (!nodeCardsMap[targetFile.nodeId]) {
              nodeCardsMap[targetFile.nodeId] = [];
            }
            nodeCardsMap[targetFile.nodeId].push(card);
            
            nodeCardsMap[targetFile.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            
            
            setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
          }
        }
      } else if (draggedFile.type === 'card' && targetFile.type === 'card') {
        
        const targetNodeId = targetFile.nodeId;
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const targetNodeCards = nodeCardsMap[targetNodeId] || [];
        const targetCard = targetNodeCards.find((c: Card) => c.docId === targetFile.cardId);
        const targetOrder = targetCard?.order || 0;
        
        
        if (draggedFile.nodeId === targetNodeId) {
          
          const allCards = [...targetNodeCards].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          const draggedCardIndex = allCards.findIndex((c: Card) => c.docId === draggedFile.cardId);
          const targetCardIndex = allCards.findIndex((c: Card) => c.docId === targetFile.cardId);
          
          if (draggedCardIndex >= 0 && targetCardIndex >= 0 && draggedCardIndex !== targetCardIndex) {
            
            const [draggedCard] = allCards.splice(draggedCardIndex, 1);
            
            let newIndex: number;
            if (effectivePosition === 'before') {
              newIndex = targetCardIndex;
            } else {
              // after
              newIndex = draggedCardIndex < targetCardIndex ? targetCardIndex : targetCardIndex + 1;
            }
            allCards.splice(newIndex, 0, draggedCard);
            
            
            allCards.forEach((card, index) => {
              card.order = index + 1;
            });
            
            
            nodeCardsMap[targetNodeId] = allCards;
            (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
            
            
            setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
            
            
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else {
          
          const draggedCard = nodeCardsMap[draggedFile.nodeId || '']?.find((c: Card) => c.docId === draggedFile.cardId);
          if (!draggedCard) {
            setDragOverFile(null);
            return;
          }
          
          let newOrder: number;
          if (effectivePosition === 'before') {
            
            newOrder = targetOrder;
            
            targetNodeCards.forEach((card: Card) => {
              if (card.order && card.order >= targetOrder) {
                card.order = (card.order || 0) + 1;
              }
            });
          } else {
            
            newOrder = targetOrder + 1;
            
            targetNodeCards.forEach((card: Card) => {
              if (card.order && card.order > targetOrder) {
                card.order = (card.order || 0) + 1;
              }
            });
          }
          
          
          if (nodeCardsMap[draggedFile.nodeId || '']) {
            const cards = nodeCardsMap[draggedFile.nodeId || ''];
            const cardIndex = cards.findIndex((c: Card) => c.docId === draggedFile.cardId);
            if (cardIndex >= 0) {
              cards.splice(cardIndex, 1);
            }
          }
          
          
          if (!nodeCardsMap[targetNodeId]) {
            nodeCardsMap[targetNodeId] = [];
          }
          draggedCard.nodeId = targetNodeId;
          draggedCard.order = newOrder;
          nodeCardsMap[targetNodeId].push(draggedCard);
          
          nodeCardsMap[targetNodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
          (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
          
          
          setPendingDragChanges(prev => new Set(prev).add(draggedFile.cardId || ''));
          
          
          setNodeCardsMapVersion(prev => prev + 1);
        }
      } else if (draggedFile.type === 'node' && targetFile.type === 'node') {
        const draggedNodeId = draggedFile.nodeId || '';
        const targetNodeId = targetFile.nodeId || '';
        
        
        const draggedParentEdge = base.edges.find(e => e.target === draggedNodeId);
        const targetParentEdge = base.edges.find(e => e.target === targetNodeId);
        const draggedParentId = draggedParentEdge?.source;
        const targetParentId = targetParentEdge?.source;
        
        
        const isSameParent = draggedParentId && targetParentId && draggedParentId === targetParentId;
        
        if (isSameParent && effectivePosition !== 'into') {
          
          
          const siblingNodes = base.edges
            .filter(e => e.source === draggedParentId)
            .map(e => {
              const node = base.nodes.find(n => n.id === e.target);
              return node ? { id: node.id, node, order: node.order || 0 } : null;
            })
            .filter(Boolean)
            .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;
          
          const draggedNodeIndex = siblingNodes.findIndex(n => n.id === draggedNodeId);
          const targetNodeIndex = siblingNodes.findIndex(n => n.id === targetNodeId);
          
          if (draggedNodeIndex >= 0 && targetNodeIndex >= 0 && draggedNodeIndex !== targetNodeIndex) {
            
            const [draggedNodeData] = siblingNodes.splice(draggedNodeIndex, 1);
            
            
            let newIndex: number;
            if (effectivePosition === 'before') {
              newIndex = targetNodeIndex;
            } else {
              // after
              newIndex = draggedNodeIndex < targetNodeIndex ? targetNodeIndex : targetNodeIndex + 1;
            }
            siblingNodes.splice(newIndex, 0, draggedNodeData);
            
            
            siblingNodes.forEach((nodeData, index) => {
              nodeData.node.order = index + 1;
            });
            
            
            setBase(prev => ({
              ...prev,
              nodes: prev.nodes.map(n => {
                const updatedNode = siblingNodes.find(sn => sn.id === n.id);
                return updatedNode ? { ...n, order: updatedNode.node.order } : n;
              }),
            }));
            
            
            setPendingDragChanges(prev => {
              const newSet = new Set(prev);
              newSet.add(`node-${draggedNodeId}`);
              return newSet;
            });
            
            
            setNodeCardsMapVersion(prev => prev + 1);
          }
        } else {
          
          
          const isDescendant = (ancestorId: string, nodeId: string): boolean => {
            
            const children = base.edges
              .filter(e => e.source === ancestorId)
              .map(e => e.target);
            
            
            if (children.includes(nodeId)) {
              return true;
            }
            
            
            return children.some(childId => isDescendant(childId, nodeId));
          };
          
          
          if (isDescendant(draggedNodeId, targetNodeId)) {
            Notification.error(i18n('Cannot move node into its own descendant'));
            setDragOverFile(null);
            return;
          }
          
          
          const existingEdge = base.edges.find(
            e => e.source === targetNodeId && e.target === draggedNodeId
          );
          
          if (!existingEdge) {
            
            const getAllDescendants = (nodeId: string): string[] => {
              const directChildren = base.edges
                .filter(e => e.source === nodeId)
                .map(e => e.target);
              
              const allDescendants = [...directChildren];
              for (const childId of directChildren) {
                allDescendants.push(...getAllDescendants(childId));
              }
              return allDescendants;
            };
            
            const draggedNodeDescendants = getAllDescendants(draggedNodeId);
            
            
            const targetChildren = base.edges.filter(e => e.source === targetNodeId);
            const targetChildNodes = targetChildren.map(e => {
              const node = base.nodes.find(n => n.id === e.target);
              return node ? { id: node.id, order: node.order || 0 } : null;
            }).filter(Boolean) as Array<{ id: string; order: number }>;
            const maxOrder = targetChildNodes.length > 0 
              ? Math.max(...targetChildNodes.map(n => n.order))
              : 0;
            const newOrder = maxOrder + 1;
            
            
            const oldEdges = base.edges.filter(
              e => e.target === draggedNodeId
            );
            
            
            const newEdges = base.edges.filter(
              e => !oldEdges.includes(e)
            );
            
            
            const newEdge: BaseEdge = {
              id: `edge-${targetNodeId}-${draggedNodeId}-${Date.now()}`,
              source: targetNodeId,
              target: draggedNodeId,
            };
            
            newEdges.push(newEdge);
            
            
            const draggedNode = base.nodes.find(n => n.id === draggedNodeId);
            
            
            setBase(prev => ({
              ...prev,
              edges: newEdges,
              nodes: prev.nodes.map(n => 
                n.id === draggedNodeId ? { ...n, order: newOrder } : n
              ),
            }));
            
            
            setPendingDragChanges(prev => {
              const newSet = new Set(prev);
              newSet.add(`node-${draggedNodeId}`);
              
              
              return newSet;
            });
            
            
            setNodeCardsMapVersion(prev => prev + 1);
          }
        }
      }
      
      
      setBase(prev => ({ ...prev }));
      
      
      
      
      
      
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
      
      setDragOverFile(null);
      setDropPosition('after');
    } catch (error: any) {
      console.error('移动失败:', error);
      setDragOverFile(null);
      setDropPosition('after');
    }
  }, [draggedFile, dropPosition, base.edges, base.nodes]);

  
  const selectedFileIdRef = useRef<string | null>(null);
  const selectedFileRef = useRef<FileItem | null>(null);
  const isInitializingRef = useRef(false);
  
  
  useEffect(() => {
    if (!editorRef.current || !selectedFile) {
      return;
    }

    
    if (selectedFileIdRef.current === selectedFile.id && editorInstance) {
      return;
    }
    
    selectedFileIdRef.current = selectedFile.id;
    isInitializingRef.current = true;

    
    if (editorInstance) {
      try {
        editorInstance.destroy();
      } catch (error) {
        console.warn('Error destroying editor:', error);
      }
      setEditorInstance(null);
    }

    let currentEditor: any = null;

    
    let retryCount = 0;
    const maxRetries = 10;
    
    const initEditor = () => {
      
      if (!editorRef.current) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element not found after retries');
        isInitializingRef.current = false;
        return;
      }

      const textareaElement = editorRef.current;
      const parentElement = textareaElement.parentElement;
      
      if (!parentElement) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element has no parent after retries');
        isInitializingRef.current = false;
        return;
      }

      
      if (!document.body.contains(textareaElement)) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Editor element not in document after retries');
        isInitializingRef.current = false;
        return;
      }

      const $textarea = $(textareaElement);
      
      
      if (selectedFile.type === 'card') {
        $textarea.attr('data-markdown', 'true');
      } else {
        $textarea.removeAttr('data-markdown');
      }

      
      $textarea.val(fileContent);
      
      
      if (!textareaElement.parentElement) {
        if (retryCount < maxRetries) {
          retryCount++;
          requestAnimationFrame(initEditor);
          return;
        }
        console.error('Textarea has no parent element after retries');
        isInitializingRef.current = false;
        return;
      }
      
      try {
        currentEditor = new Editor($textarea, {
          value: fileContent,
          language: selectedFile.type === 'card' ? undefined : 'plain',
          onChange: (value: string) => {
            
            if (isInitializingRef.current) {
              return;
            }
            setFileContent(value);
            
            
            const currentSelectedFile = selectedFileRef.current;
            if (currentSelectedFile) {
              const originalContent = originalContentsRef.current.get(currentSelectedFile.id) || '';
              
              
              if (value !== originalContent) {
                setPendingChanges(prev => {
                  const newMap = new Map(prev);
                  newMap.set(currentSelectedFile.id, {
                    file: currentSelectedFile,
                    content: value,
                    originalContent: originalContent,
                  });
                  return newMap;
                });
              } else {
                
                setPendingChanges(prev => {
                  const newMap = new Map(prev);
                  if (newMap.has(currentSelectedFile.id)) {
                    newMap.delete(currentSelectedFile.id);
                  }
                  return newMap;
                });
              }
            }
          },
        });

        
        
        setTimeout(() => {
          setEditorInstance(currentEditor);
          isInitializingRef.current = false;
        }, 100);
      } catch (error) {
        console.error('Failed to initialize editor:', error);
        isInitializingRef.current = false;
      }
    };

    
    const timer = setTimeout(() => {
      requestAnimationFrame(initEditor);
    }, 200);

    return () => {
      clearTimeout(timer);
      if (currentEditor) {
        try {
          currentEditor.destroy();
        } catch (error) {
          console.warn('Error destroying editor in cleanup:', error);
        }
      }
      isInitializingRef.current = false;
    };
  }, [selectedFile?.id]);
  
  
  useEffect(() => {
    if (!editorInstance || !selectedFile || isInitializingRef.current) {
      return;
    }
    
    
    if (selectedFileIdRef.current === selectedFile.id) {
      try {
        const currentValue = editorInstance.value();
        if (currentValue !== fileContent) {
          editorInstance.value(fileContent);
        }
      } catch (e) {
        
        console.warn('Failed to update editor content:', e);
      }
    }
  }, [fileContent, editorInstance, selectedFile]);

  useEffect(() => {
    if (basePath !== 'base/skill') return;
    const domainId = (window as any).UiContext?.domainId;
    if (!domainId) return;
    setDomainToolsLoading(true);
    request.get(`/d/${domainId}/tool/api/list`)
      .then((data: any) => {
        setDomainTools(data?.tools ?? []);
      })
      .catch(() => {
        setDomainTools([]);
      })
      .finally(() => {
        setDomainToolsLoading(false);
      });
  }, [basePath]);

  
  useEffect(() => {
    return () => {
      
    };
  }, []);

  return (
    <div style={{
      display: 'flex',
      height: isMobile ? '100dvh' : '100vh',
      width: '100%',
      backgroundColor: themeStyles.bgPrimary,
    }}>
      {isMobile && mobileExplorerOpen && (
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setMobileExplorerOpen(false)}
          aria-hidden
        />
      )}
      <div style={{
        ...(isMobile
          ? {
              position: 'fixed' as const,
              left: 0,
              top: 0,
              bottom: 0,
              width: '280px',
              maxWidth: '85vw',
              zIndex: 1002,
              transform: mobileExplorerOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease',
              boxShadow: mobileExplorerOpen ? '4px 0 16px rgba(0,0,0,0.15)' : 'none',
              paddingTop: 'env(safe-area-inset-top, 0px)',
            }
          : {
              width: '250px',
              flexShrink: 0,
            }),
        borderRight: `1px solid ${themeStyles.borderPrimary}`,
        backgroundColor: themeStyles.bgSecondary,
        overflow: 'auto',
        WebkitOverflowScrolling: 'touch',
      } as React.CSSProperties}
        ref={explorerScrollRef}
      >
        <div style={{
          padding: isMobile ? '12px 16px' : '12px 16px',
          borderBottom: `1px solid ${themeStyles.borderPrimary}`,
          fontSize: '12px',
          fontWeight: '600',
          color: themeStyles.textSecondary,
          backgroundColor: themeStyles.bgPrimary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>EXPLORER</span>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {isMobile && (
              <button
                type="button"
                onClick={() => setMobileExplorerOpen(false)}
                style={{
                  padding: '6px 10px',
                  minHeight: '36px',
                  fontSize: '11px',
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  background: themeStyles.bgButton,
                  color: themeStyles.textSecondary,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            )}
            {explorerMode === 'tree' && (
              <>
                <button
                  onClick={() => {
                    setIsMultiSelectMode(!isMultiSelectMode);
                    if (isMultiSelectMode) {
                      setSelectedItems(new Set());
                    }
                  }}
                  style={{
                    padding: isMobile ? '8px 10px' : '2px 8px',
                    minHeight: isMobile ? '36px' : undefined,
                    fontSize: '11px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    borderRadius: '3px',
                    backgroundColor: isMultiSelectMode ? themeStyles.bgButtonActive : themeStyles.bgButton,
                    color: isMultiSelectMode ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                    cursor: 'pointer',
                  }}
                  title={isMultiSelectMode ? i18n('Exit multi-select') : i18n('Multi-select')}
                >
                  {isMultiSelectMode ? '✓' : '☐'}
                </button>
              </>
            )}
            <button
              onClick={() => setExplorerMode('tree')}
              style={{
                padding: isMobile ? '8px 10px' : '2px 8px',
                minHeight: isMobile ? '36px' : undefined,
                fontSize: '11px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: explorerMode === 'tree' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: explorerMode === 'tree' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
              }}
              title="树形视图"
            >
              树形
            </button>
            <button
              onClick={() => setExplorerMode('files')}
              style={{
                padding: isMobile ? '8px 10px' : '2px 8px',
                minHeight: isMobile ? '36px' : undefined,
                fontSize: '11px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: explorerMode === 'files' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: explorerMode === 'files' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
              }}
              title={i18n('File view')}
            >
              文件
            </button>
            <button
              onClick={() => setExplorerMode('pending')}
              style={{
                padding: isMobile ? '8px 10px' : '2px 8px',
                minHeight: isMobile ? '36px' : undefined,
                fontSize: '11px',
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: explorerMode === 'pending' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                color: explorerMode === 'pending' ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                cursor: 'pointer',
              }}
              title="查看待提交的更改"
            >
              修改
            </button>
          </div>
        </div>
        <div style={{ padding: '8px 0' }}>
          {explorerMode === 'tree' ? (
            fileTree.map((file, index) => {
            // 单选模式只认 selectedFile，多选模式只认 selectedItems；单选时 selectedItems 已在 handleSelectFile 中清空，保证最多一个高亮
            const isSelected = isMultiSelectMode
              ? selectedItems.has(file.id)
              : (selectedFile?.id === file.id);
            // 仅当该行是树中第一个 id 与 selectedFile 匹配的项时才高亮，保证最多一个蓝色高亮（避免 id 重复时多行同时高亮）
            const selectedIndex = selectedFile != null ? fileTree.findIndex(f => f.id === selectedFile.id) : -1;
            const isHighlighted = !isMultiSelectMode && selectedFile != null && selectedFile.id === file.id && selectedIndex === index;
            const isDragOver = dragOverFile?.id === file.id;
            const isDragged = draggedFile?.id === file.id;
            const isEditing = editingFile?.id === file.id;
            const isExpanded = file.type === 'node' && expandedNodes.has(file.nodeId || '');
            
            return (
              <div
                key={`${file.parentId ?? 'root'}-${file.level}-${file.id}-${index}`}
                data-file-item
                data-file-id={file.id}
                draggable={true}
                onDragStart={(e) => handleDragStart(e, file)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, file)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => {
                  handleDrop(e, file);
                  
                  if (dragLeaveTimeoutRef.current) {
                    clearTimeout(dragLeaveTimeoutRef.current);
                    dragLeaveTimeoutRef.current = null;
                  }
                  if (dragOverTimeoutRef.current) {
                    clearTimeout(dragOverTimeoutRef.current);
                    dragOverTimeoutRef.current = null;
                  }
                  setDragOverFile(null);
                  setDropPosition('after');
                  lastDragOverFileRef.current = null;
                  lastDropPositionRef.current = 'after';
                }}
                onClick={(e) => {
                  if (isEditing) return;
                  if (file.type === 'node') {
                    const target = e.target as HTMLElement;
                    if (target.style.cursor === 'pointer' && (target.textContent === '▼' || target.textContent === '▶')) {
                      return;
                    }
                  }
                  handleSelectFile(file);
                  if (isMobile) {
                    if (mobileExplorerCloseTimeoutRef.current) {
                      clearTimeout(mobileExplorerCloseTimeoutRef.current);
                      mobileExplorerCloseTimeoutRef.current = null;
                    }
                    mobileExplorerCloseTimeoutRef.current = setTimeout(() => {
                      setMobileExplorerOpen(false);
                      mobileExplorerCloseTimeoutRef.current = null;
                    }, 400);
                  }
                }}
                onDoubleClick={(e) => {
                  if (isMobile) {
                    if (mobileExplorerCloseTimeoutRef.current) {
                      clearTimeout(mobileExplorerCloseTimeoutRef.current);
                      mobileExplorerCloseTimeoutRef.current = null;
                    }
                    return;
                  }
                  handleStartRename(file, e);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, file });
                }}
                onTouchStart={(e) => {
                  if (!isMobile || isEditing) return;
                  const touch = e.touches[0];
                  touchDragStartPosRef.current = { x: touch.clientX, y: touch.clientY };
                  longPressFileRef.current = file;
                  longPressPosRef.current = { x: touch.clientX, y: touch.clientY };
                  longPressTimerRef.current = window.setTimeout(() => {
                    setContextMenu({ x: longPressPosRef.current.x, y: longPressPosRef.current.y, file: longPressFileRef.current! });
                    longPressTimerRef.current = null;
                  }, 500);
                }}
                onTouchEnd={() => {
                  if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current);
                    longPressTimerRef.current = null;
                  }
                }}
                onTouchMove={(e) => {
                  if (!isMobile) return;
                  if (longPressTimerRef.current) {
                    const touch = e.touches[0];
                    const start = touchDragStartPosRef.current;
                    const dx = touch.clientX - start.x;
                    const dy = touch.clientY - start.y;
                    if (Math.sqrt(dx * dx + dy * dy) > 10) {
                      clearTimeout(longPressTimerRef.current);
                      longPressTimerRef.current = null;
                    }
                  }
                  
                  if (isMobile) return;
                  if (touchDragFileRef.current) return;
                  const touch = e.touches[0];
                  const start = touchDragStartPosRef.current;
                  const dx = touch.clientX - start.x;
                  const dy = touch.clientY - start.y;
                  if (Math.sqrt(dx * dx + dy * dy) <= 10) return;
                  touchDragFileRef.current = file;
                  setDraggedFile(file);
                  const onDocTouchMove = (ev: TouchEvent) => {
                    if (ev.touches.length === 0) return;
                    const t = ev.touches[0];
                    ev.preventDefault();
                    const el = document.elementFromPoint(t.clientX, t.clientY);
                    const itemEl = el?.closest?.('[data-file-item]') as HTMLElement | null;
                    const fileId = itemEl?.getAttribute?.('data-file-id');
                    const tree = fileTreeRef.current;
                    const targetFile = fileId && tree ? tree.find(f => f.id === fileId) : null;
                    const dragged = touchDragFileRef.current;
                    if (!dragged || !targetFile || targetFile.id === dragged.id) {
                      if (targetFile?.id !== dragged?.id) {
                        setDragOverFile(null);
                        touchDragOverFileRef.current = null;
                      }
                      return;
                    }
                    const rect = itemEl.getBoundingClientRect();
                    const edges = baseEdgesRef.current;
                    const pos = getDropPositionForTouch(dragged, targetFile, t.clientY, rect, edges);
                    setDragOverFile(targetFile);
                    setDropPosition(pos);
                    touchDragOverFileRef.current = targetFile;
                    touchDropPositionRef.current = pos;
                  };
                  const removeListeners = () => {
                    if (!touchDragListenersRef.current) return;
                    document.removeEventListener('touchmove', touchDragListenersRef.current.move);
                    document.removeEventListener('touchend', touchDragListenersRef.current.end);
                    document.removeEventListener('touchcancel', touchDragListenersRef.current.cancel);
                    touchDragListenersRef.current = null;
                  };
                  const onDocTouchEnd = () => {
                    removeListeners();
                    const over = touchDragOverFileRef.current;
                    const dragged = touchDragFileRef.current;
                    if (over && dragged && over.id !== dragged.id) {
                      handleDrop(
                        { preventDefault: () => {}, stopPropagation: () => {} } as React.DragEvent,
                        over,
                        touchDropPositionRef.current
                      );
                    }
                    handleDragEnd();
                    touchDragFileRef.current = null;
                    touchDragOverFileRef.current = null;
                  };
                  const onDocTouchCancel = () => {
                    removeListeners();
                    handleDragEnd();
                    touchDragFileRef.current = null;
                    touchDragOverFileRef.current = null;
                  };
                  document.addEventListener('touchmove', onDocTouchMove, { passive: false });
                  document.addEventListener('touchend', onDocTouchEnd, { passive: true });
                  document.addEventListener('touchcancel', onDocTouchCancel, { passive: true });
                  touchDragListenersRef.current = { move: onDocTouchMove, end: onDocTouchEnd, cancel: onDocTouchCancel };
                }}
                style={{
                  padding: `4px ${8 + file.level * 16}px`,
                  cursor: isEditing ? 'text' : 'pointer',
                  fontSize: '13px',
                  color: isHighlighted ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                  backgroundColor: isHighlighted
                    ? themeStyles.bgSelected
                    : isDragOver
                      ? themeStyles.bgDragOver
                      : isDragged
                        ? themeStyles.bgDragged
                        : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  opacity: isDragged ? 0.5 : 1,
                  border: isDragOver 
                    ? dropPosition === 'into'
                      ? `2px dashed ${themeStyles.accent}` 
                      : `2px solid ${themeStyles.accent}`
                    : file.clipboardType === 'cut'
                      ? `2px dashed ${themeStyles.error}`
                      : file.clipboardType === 'copy'
                        ? `2px dashed ${themeStyles.success}`
                        : file.hasPendingChanges
                          ? `1px dashed ${themeStyles.warning}`
                          : '2px solid transparent',
                  borderTop: isDragOver && dropPosition === 'before' 
                    ? `3px solid ${themeStyles.accent}` 
                    : undefined,
                  borderBottom: isDragOver && dropPosition === 'after' 
                    ? `3px solid ${themeStyles.accent}` 
                    : undefined,
                }}
                onMouseEnter={(e) => {
                  if (!isHighlighted && !isDragOver && !isDragged) {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isHighlighted && !isDragOver && !isDragged) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
              {isMultiSelectMode && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggleSelect(file)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginRight: '6px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                />
              )}
              {file.type === 'node' ? (
                <>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleNodeExpanded(file.nodeId || '');
                    }}
                    style={{
                      width: '16px',
                      height: '16px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                      fontSize: '10px',
                      color: themeStyles.textTertiary,
                      userSelect: 'none',
                      marginRight: '2px',
                    }}
                    title={isExpanded ? i18n('Collapse') : i18n('Expand')}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </span>
                  <span style={{ 
                    fontSize: '16px', 
                    flexShrink: 0,
                    width: '16px',
                    height: '16px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {isExpanded ? '📁' : '📂'}
                  </span>
                </>
              ) : (
                <span style={{ 
                  fontSize: '14px', 
                  flexShrink: 0,
                  width: '16px',
                  height: '16px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginLeft: '18px',
                }}>
                  📄
                </span>
              )}
              {isEditing ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={async () => {
                    
                    if (editingFile && editingName.trim() && editingName !== editingFile.name) {
                      await handleConfirmRename();
                    } else {
                      handleCancelRename();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      handleCancelRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  style={{
                    flex: 1,
                    padding: '2px 4px',
                    fontSize: '13px',
                    border: `1px solid ${themeStyles.borderFocus}`,
                    borderRadius: '3px',
                    outline: 'none',
                    backgroundColor: themeStyles.bgPrimary,
                    color: themeStyles.textPrimary,
                  }}
                />
              ) : (
                <span style={{ 
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  {file.name}
                  {file.clipboardType === 'cut' && (
                    <span style={{ 
                      fontSize: '10px', 
                      color: '#f44336',
                      fontWeight: 'bold',
                    }} title="已剪切">
                      ✂
                    </span>
                  )}
                  {file.clipboardType === 'copy' && (
                    <span style={{ 
                      fontSize: '10px', 
                      color: '#4caf50',
                      fontWeight: 'bold',
                    }} title={i18n('Copied')}>
                      📋
                    </span>
                  )}
                </span>
              )}
              {isMobile && !isEditing && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const rect = (e.target as HTMLElement).getBoundingClientRect();
                    setContextMenu({ x: rect.left, y: rect.bottom + 4, file });
                  }}
                  style={{
                    flexShrink: 0,
                    width: '36px',
                    minHeight: '36px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    background: 'transparent',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                    fontSize: '18px',
                    marginLeft: '4px',
                  }}
                  aria-label="操作"
                >
                  ⋯
                </button>
              )}
            </div>
            );
          })
          ) : explorerMode === 'files' ? (
            
            <div style={{ padding: '8px' }}>
              {/* Button to file management */}
              <div style={{ marginBottom: '8px' }}>
                <button
                  onClick={() => {
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    const branch = base.currentBranch || 'main';
                    const filesUrl = docId 
                      ? `/d/${domainId}/base/${docId}/files${branch ? `?branch=${branch}` : ''}`
                      : `/d/${domainId}/base/bid/${base.bid}/files${branch ? `?branch=${branch}` : ''}`;
                    window.open(filesUrl, '_blank');
                  }}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '12px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    borderRadius: '3px',
                    backgroundColor: themeStyles.bgButton,
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgButtonHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgButton;
                  }}
                >
                  <span>📁</span>
                  <span>管理文件</span>
                </button>
              </div>
              
              {/* File list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {files.length === 0 ? (
                  <div style={{
                    padding: '20px',
                    textAlign: 'center',
                    color: themeStyles.textTertiary,
                    fontSize: '12px',
                  }}>
                    暂无文件
                  </div>
                ) : (
                  files.map((file) => (
                    <div
                      key={file._id}
                      onClick={() => {
                        const branch = base.currentBranch || 'main';
                        let url = docId 
                          ? getBaseUrl(`/${docId}/file/${encodeURIComponent(file.name)}`)
                          : getBaseUrl(`/bid/${base.bid}/file/${encodeURIComponent(file.name)}`);
                        
                        url = url.includes('?') ? `${url}&noDisposition=1` : `${url}?noDisposition=1`;
                        window.open(url, '_blank');
                        setSelectedFileForPreview(file.name);
                      }}
                      style={{
                        padding: '6px 8px',
                        fontSize: '12px',
                        color: selectedFileForPreview === file.name ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                        backgroundColor: selectedFileForPreview === file.name ? themeStyles.bgSelected : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        borderRadius: '3px',
                      }}
                      onMouseEnter={(e) => {
                        if (selectedFileForPreview !== file.name) {
                          e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (selectedFileForPreview !== file.name) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }
                      }}
                    >
                      <span style={{ fontSize: '14px' }}>📄</span>
                      <span style={{ 
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {file.name}
                      </span>
                      <span style={{ 
                        fontSize: '11px',
                        color: selectedFileForPreview === file.name ? 'rgba(255,255,255,0.8)' : themeStyles.textTertiary,
                      }}>
                        {(file.size / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            
            <div style={{ padding: '8px' }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '600',
                color: themeStyles.textSecondary,
                marginBottom: '12px',
                padding: '0 8px',
              }}>
                待提交的更改
              </div>
              <div style={{
                fontSize: '11px',
                color: themeStyles.textSecondary,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '0 8px',
              }}>
                {/* Content changes */}
                {pendingChanges.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>内容更改 ({pendingChanges.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingChanges.values()).slice(0, 5).map((change, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {change.file.name}
                        </div>
                      ))}
                      {pendingChanges.size > 5 && (
                        <div style={{ color: themeStyles.textTertiary, fontStyle: 'italic' }}>... 还有 {pendingChanges.size - 5} 个</div>
          )}
        </div>
      </div>
                )}
                
                {/* Drag changes */}
                {pendingDragChanges.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>拖动更改 ({pendingDragChanges.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDragChanges).slice(0, 5).map((item, idx) => {
                        const file = fileTree.find(f => 
                          (f.type === 'node' && f.nodeId === item.replace('node-', '')) ||
                          (f.type === 'card' && f.cardId === item)
                        );
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : item}
                          </div>
                        );
                      })}
                      {pendingDragChanges.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDragChanges.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* 重命名更改 */}
                {pendingRenames.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>重命名 ({pendingRenames.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingRenames.values()).slice(0, 5).map((rename, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {rename.file.name} → {rename.newName}
                        </div>
                      ))}
                      {pendingRenames.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingRenames.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Card face changes */}
                {Object.keys(pendingCardFaceChanges).length > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>卡面更改 ({Object.keys(pendingCardFaceChanges).length})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Object.keys(pendingCardFaceChanges).slice(0, 5).map((cardId) => {
                        const file = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
                        return (
                          <div key={cardId} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : cardId}
                          </div>
                        );
                      })}
                      {Object.keys(pendingCardFaceChanges).length > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {Object.keys(pendingCardFaceChanges).length - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* New items */}
                {pendingCreatesCount > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>新建 ({pendingCreatesCount})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingCreatesRef.current.values()).slice(0, 5).map((create, idx) => (
                        <div key={idx} style={{ marginBottom: '2px' }}>
                          • {create.type === 'card' ? i18n('Card') : i18n('Node')}: {create.title || create.text || i18n('Unnamed')}
                        </div>
                      ))}
                      {pendingCreatesCount > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingCreatesCount - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Deletions */}
                {pendingDeletes.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>删除 ({pendingDeletes.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDeletes.values()).slice(0, 5).map((del, idx) => {
                        const file = fileTree.find(f => 
                          (del.type === 'node' && f.type === 'node' && f.nodeId === del.id) ||
                          (del.type === 'card' && f.type === 'card' && f.cardId === del.id)
                        );
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {file ? file.name : `${del.type === 'card' ? i18n('Card') : i18n('Node')} (${del.id.substring(0, 8)}...)`}
                          </div>
                        );
                      })}
                      {pendingDeletes.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDeletes.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Problem creates */}
                {pendingNewProblemCardIds.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>题目新建 ({pendingNewProblemCardIds.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingNewProblemCardIds).slice(0, 5).map((cardId, idx) => {
                        
                        const file = fileTree.find(f => 
                          f.type === 'card' && f.cardId === cardId
                        );
                        
                        let cardName = file ? file.name : '';
                        if (!cardName) {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          for (const nodeId in nodeCardsMap) {
                            const cards = nodeCardsMap[nodeId] || [];
                            const card = cards.find((c: Card) => c.docId === cardId);
                            if (card) {
                              cardName = card.title || i18n('Unnamed Card');
                              break;
                            }
                          }
                        }
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {cardName || `卡片 (${cardId.substring(0, 8)}...)`}
                          </div>
                        );
                      })}
                      {pendingNewProblemCardIds.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingNewProblemCardIds.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Problem edits */}
                {pendingEditedProblemIds.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>题目更改 ({pendingEditedProblemIds.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingEditedProblemIds.entries()).slice(0, 5).map(([cardId, problemIds], idx) => {
                        
                        const file = fileTree.find(f => 
                          f.type === 'card' && f.cardId === cardId
                        );
                        
                        let cardName = file ? file.name : '';
                        if (!cardName) {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          for (const nodeId in nodeCardsMap) {
                            const cards = nodeCardsMap[nodeId] || [];
                            const card = cards.find((c: Card) => c.docId === cardId);
                            if (card) {
                              cardName = card.title || i18n('Unnamed Card');
                              break;
                            }
                          }
                        }
                        const problemCount = problemIds.size;
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {cardName || `卡片 (${cardId.substring(0, 8)}...)`} ({problemCount} 个题目)
                          </div>
                        );
                      })}
                      {pendingEditedProblemIds.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingEditedProblemIds.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Problem deletes */}
                {pendingDeleteProblemIds.size > 0 && (
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '4px' }}>题目删除 ({pendingDeleteProblemIds.size})</div>
                    <div style={{ paddingLeft: '12px', fontSize: '10px', color: '#6a737d' }}>
                      {Array.from(pendingDeleteProblemIds.entries()).slice(0, 5).map(([problemId, cardId], idx) => {
                        
                        const file = fileTree.find(f => 
                          f.type === 'card' && f.cardId === cardId
                        );
                        
                        let cardName = file ? file.name : '';
                        if (!cardName) {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          for (const nodeId in nodeCardsMap) {
                            const cards = nodeCardsMap[nodeId] || [];
                            const card = cards.find((c: Card) => c.docId === cardId);
                            if (card) {
                              cardName = card.title || i18n('Unnamed Card');
                              break;
                            }
                          }
                        }
                        return (
                          <div key={idx} style={{ marginBottom: '2px' }}>
                            • {cardName || `卡片 (${cardId.substring(0, 8)}...)`} - 题目 ({problemId.substring(0, 8)}...)
                          </div>
                        );
                      })}
                      {pendingDeleteProblemIds.size > 5 && (
                        <div style={{ color: '#999', fontStyle: 'italic' }}>... 还有 {pendingDeleteProblemIds.size - 5} 个</div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* No pending changes */}
                {pendingChanges.size === 0 && 
                 pendingDragChanges.size === 0 && 
                 pendingRenames.size === 0 && 
                 Object.keys(pendingCardFaceChanges).length === 0 &&
                 pendingCreatesCount === 0 && 
                 pendingDeletes.size === 0 &&
                 pendingProblemCardIds.size === 0 &&
                 pendingNewProblemCardIds.size === 0 &&
                 pendingEditedProblemIds.size === 0 &&
                 pendingDeleteProblemIds.size === 0 && (
                  <div style={{ 
                    color: themeStyles.textTertiary, 
                    fontStyle: 'italic',
                    textAlign: 'center',
                    padding: '8px 0',
                  }}>
                    暂无待提交的更改
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>


      {/* Context menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '4px',
            boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
            zIndex: 1100,
            minWidth: '180px',
            padding: '4px 0',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.file.type === 'node' ? (
            <>
              {/* Paste (when clipboard has content) */}
              {clipboard && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handlePaste(contextMenu.file.nodeId || '')}
                  >
                    粘贴{clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}
                  </div>
                  <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
                </>
              )}
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleOpenImportWindow(contextMenu.file.nodeId || '')}
              >
                导入
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              {/* Multi-select: copy, cut, delete */}
              {isMultiSelectMode && selectedItems.size > 0 && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCopy()}
                  >
                    复制选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCut()}
                  >
                    剪切选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: '#d73a49',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      handleBatchDelete();
                      setContextMenu(null);
                    }}
                  >
                    删除选中项 ({selectedItems.size})
                  </div>
                  <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
                </>
              )}
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleNewCard(contextMenu.file.nodeId || '')}
              >
                新建 Card
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleNewChildNode(contextMenu.file.nodeId || '')}
              >
                新建子 Node
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  setSortWindow({ nodeId: contextMenu.file.nodeId || '' });
                  setContextMenu(null);
                }}
              >
                排序
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  handleExportToPDF(contextMenu.file.nodeId || '');
                }}
              >
                导出为PDF
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  handleStartRename(contextMenu.file, { stopPropagation: () => {} } as React.MouseEvent);
                  setContextMenu(null);
                }}
              >
                重命名
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopy(contextMenu.file)}
              >
                复制
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopyContent(contextMenu.file)}
              >
                复制内容
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCut(contextMenu.file)}
              >
                剪切
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#d73a49',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleDelete(contextMenu.file)}
              >
                删除 Node
              </div>
            </>
          ) : (
            <>
              {/* Multi-select: copy, cut, delete */}
              {isMultiSelectMode && selectedItems.size > 0 && (
                <>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCopy()}
                  >
                    复制选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: themeStyles.textPrimary,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => handleCut()}
                  >
                    剪切选中项 ({selectedItems.size})
                  </div>
                  <div
                    style={{
                      padding: '6px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: '#d73a49',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    onClick={() => {
                      handleBatchDelete();
                      setContextMenu(null);
                    }}
                  >
                    删除选中项 ({selectedItems.size})
                  </div>
                  <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
                </>
              )}
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  handleStartRename(contextMenu.file, { stopPropagation: () => {} } as React.MouseEvent);
                  setContextMenu(null);
                }}
              >
                重命名
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopy(contextMenu.file)}
              >
                复制
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCopyContent(contextMenu.file)}
              >
                复制内容
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: themeStyles.textPrimary,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => {
                  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                  const card = (nodeCardsMap[contextMenu.file.nodeId || ''] || []).find((c: Card) => c.docId === contextMenu.file.cardId);
                  const initial = pendingCardFaceChanges[contextMenu.file.cardId || ''] ?? card?.cardFace ?? '';
                  setCardFaceEditContent(initial);
                  setCardFaceWindow({ file: contextMenu.file });
                  setContextMenu(null);
                }}
              >
                编辑卡面
              </div>
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#24292e',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleCut(contextMenu.file)}
              >
                剪切
              </div>
              <div style={{ height: '1px', backgroundColor: '#e1e4e8', margin: '4px 0' }} />
              <div
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#d73a49',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                onClick={() => handleDelete(contextMenu.file)}
              >
                删除 Card
              </div>
            </>
          )}
        </div>
      )}

      {/* Empty area context menu */}
      {emptyAreaContextMenu && (
        <div
          style={{
            position: 'fixed',
            left: emptyAreaContextMenu.x,
            top: emptyAreaContextMenu.y,
            backgroundColor: themeStyles.bgPrimary,
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '4px',
            boxShadow: theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
            zIndex: 1100,
            minWidth: '180px',
            padding: '4px 0',
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => handleNewRootNode()}
          >
            新建 Node
          </div>
          <div
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              fontSize: '13px',
              color: themeStyles.textPrimary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = themeStyles.bgHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => handleNewRootCard()}
          >
            新建 Card
          </div>
        </div>
      )}

      {/* Click outside to close menu */}
      {(contextMenu || emptyAreaContextMenu) && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1099,
          }}
          onClick={() => {
            setContextMenu(null);
            setEmptyAreaContextMenu(null);
          }}
        />
      )}

      {/* Sort window */}
      {sortWindow && (
        <SortWindow
          nodeId={sortWindow.nodeId}
          base={base}
          docId={docId}
          getBaseUrl={getBaseUrl}
          onClose={() => setSortWindow(null)}
          nodeCardsMapVersion={nodeCardsMapVersion}
          themeStyles={themeStyles}
          theme={theme}
          onSave={async (sortedItems) => {
            try {
              const domainId = (window as any).UiContext?.domainId || 'system';
              const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
              
              
              const updatedNodes = base.nodes.map(node => {
                const sortedItem = sortedItems.find(item => item.type === 'node' && item.id === node.id);
                if (sortedItem && node.order !== sortedItem.order) {
                  return { ...node, order: sortedItem.order };
                }
                return node;
              });
              
              
              setBase(prev => ({
                ...prev,
                nodes: updatedNodes,
              }));
              
              
              for (const sortedItem of sortedItems) {
                if (sortedItem.type === 'card') {
                  const card = (nodeCardsMap[sortWindow.nodeId] || []).find((c: Card) => c.docId === sortedItem.id);
                  if (card && card.order !== sortedItem.order) {
                    card.order = sortedItem.order;
                  }
                }
              }
              
              并排序
              if (nodeCardsMap[sortWindow.nodeId]) {
                nodeCardsMap[sortWindow.nodeId].sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
                (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
              }
              
              
              setNodeCardsMapVersion(prev => prev + 1);
              
              
              setPendingDragChanges(prev => {
                const newSet = new Set(prev);
                sortedItems.forEach(item => {
                  if (item.type === 'node') {
                    newSet.add(`node-${item.id}`);
                  } else {
                    newSet.add(`card-${item.id}`);
                  }
                });
                return newSet;
              });
              
              Notification.success(i18n('Sort order updated, click Save to persist'));
              setSortWindow(null);
            } catch (error: any) {
              console.error('Failed to save sort order:', error);
              Notification.error(`保存排序失败: ${error?.message || '未知错误'}`);
            }
          }}
        />
      )}

      {/* Import window */}
      {importWindow && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.3)',
              zIndex: 1100,
            }}
            onClick={() => setImportWindow(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '560px',
              maxHeight: '80vh',
              backgroundColor: themeStyles.bgPrimary,
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '8px',
              boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.5)' : '0 4px 24px rgba(0,0,0,0.15)',
              zIndex: 1101,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              fontSize: '15px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
            }}>
              导入
            </div>
            <div style={{ padding: '16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: themeStyles.textSecondary }}>
                {i18n('Import hint')}
              </p>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'## 1\n\n内容……\n\n---\n\n## 2\n\n内容……'}
                style={{
                  width: '100%',
                  flex: 1,
                  minHeight: '200px',
                  padding: '12px',
                  fontSize: '13px',
                  fontFamily: 'monospace',
                  color: themeStyles.textPrimary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderPrimary}`,
                  borderRadius: '4px',
                  resize: 'vertical',
                }}
              />
            </div>
            <div style={{
              padding: '12px 16px',
              borderTop: `1px solid ${themeStyles.borderPrimary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
            }}>
              <button
                type="button"
                onClick={() => setImportWindow(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: themeStyles.textSecondary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  doImportFromText(importWindow.nodeId, importText);
                  setImportWindow(null);
                  setImportText('');
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: '#fff',
                  backgroundColor: themeStyles.accent,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                确定
              </button>
            </div>
          </div>
        </>
      )}

      {/* Card face editor */}
      {cardFaceWindow && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.3)',
              zIndex: 1100,
            }}
            onClick={() => setCardFaceWindow(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '640px',
              maxHeight: '80vh',
              backgroundColor: themeStyles.bgPrimary,
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '8px',
              boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.5)' : '0 4px 24px rgba(0,0,0,0.15)',
              zIndex: 1101,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              fontSize: '15px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
            }}>
              编辑卡面
            </div>
            <div style={{ padding: '16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: themeStyles.textSecondary }}>
                卡面会在 lesson 中与 Know it / No impression 一起展示，支持 Markdown
              </p>
              <textarea
                ref={cardFaceEditorRef}
                key={cardFaceWindow?.file?.cardId ?? 'card-face-editor'}
                defaultValue={cardFaceEditContent}
                data-markdown="true"
                style={{
                  width: '100%',
                  flex: 1,
                  minHeight: '240px',
                  padding: '12px',
                  fontSize: '13px',
                  fontFamily: 'monospace',
                  color: themeStyles.textPrimary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderPrimary}`,
                  borderRadius: '4px',
                  resize: 'vertical',
                }}
              />
            </div>
            <div style={{
              padding: '12px 16px',
              borderTop: `1px solid ${themeStyles.borderPrimary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
            }}>
              <button
                type="button"
                onClick={() => setCardFaceWindow(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: themeStyles.textSecondary,
                  backgroundColor: themeStyles.bgSecondary,
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const { file } = cardFaceWindow;
                  const cardId = file.cardId || '';
                  setPendingCardFaceChanges(prev => ({ ...prev, [cardId]: (cardFaceEditorInstanceRef.current && typeof cardFaceEditorInstanceRef.current.value === 'function' ? cardFaceEditorInstanceRef.current.value() : cardFaceEditContent) }));
                  const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                  const nodeId = file.nodeId || '';
                  if (nodeCardsMap[nodeId]) {
                    const cards = nodeCardsMap[nodeId];
                    const idx = cards.findIndex((c: Card) => c.docId === cardId);
                    if (idx >= 0) {
                      cards[idx] = { ...cards[idx], cardFace: (cardFaceEditorInstanceRef.current && typeof cardFaceEditorInstanceRef.current.value === 'function' ? cardFaceEditorInstanceRef.current.value() : cardFaceEditContent) };
                      (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
                      setNodeCardsMapVersion(prev => prev + 1);
                    }
                  }
                  if (cardFaceEditorInstanceRef.current) {
                    try { cardFaceEditorInstanceRef.current.destroy(); } catch (_) {}
                    cardFaceEditorInstanceRef.current = null;
                  }
                  if (cardFaceEditorInstanceRef.current) {
                    try { cardFaceEditorInstanceRef.current.destroy(); } catch (e) {}
                    cardFaceEditorInstanceRef.current = null;
                  }
                  setCardFaceWindow(null);
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  color: '#fff',
                  backgroundColor: themeStyles.accent,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                确定
              </button>
            </div>
          </div>
        </>
      )}

      <div style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        width: (showAIChat && !isMobile) || (showProblemPanel && !isMobile)
          ? `calc(100% - ${(showAIChat && !isMobile ? chatPanelWidth : 0) + (showProblemPanel && !isMobile ? PROBLEM_PANEL_WIDTH : 0)}px)`
          : (basePath === 'base/skill' && !isMobile ? undefined : '100%'),
        transition: isResizing ? 'none' : 'width 0.3s ease',
        paddingTop: isMobile ? 'env(safe-area-inset-top, 0px)' : 0,
        paddingLeft: isMobile ? 'env(safe-area-inset-left, 0px)' : 0,
        paddingRight: isMobile ? 'env(safe-area-inset-right, 0px)' : 0,
        paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 0px)' : 0,
      }}>
        <div style={{
          padding: isMobile ? '12px 16px' : '8px 16px',
          paddingTop: isMobile ? 'max(12px, env(safe-area-inset-top, 0px))' : '8px',
          borderBottom: `1px solid ${themeStyles.borderPrimary}`,
          backgroundColor: themeStyles.bgPrimary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: isMobile ? '8px' : 0,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: isMobile ? '1 1 100%' : undefined }}>
            <a
              href={getBaseUrl(`/${docId}/branch/${base.currentBranch || 'main'}`)}
              style={{
                padding: isMobile ? '10px 12px' : '4px 8px',
                minHeight: isMobile ? '44px' : undefined,
                fontSize: '12px',
                color: themeStyles.textSecondary,
                textDecoration: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              ← 返回
            </a>
            {selectedFile && (
              <div style={{ fontSize: '13px', color: themeStyles.textSecondary }}>
                {selectedFile.name}
              </div>
            )}
          </div>
          {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
            {selectedFile?.type === 'card' && (
              <button
                type="button"
                onClick={() => setShowProblemPanel((prev) => !prev)}
                aria-label="题目"
                style={{
                  padding: isMobile ? '10px 12px' : '4px 10px',
                  minHeight: isMobile ? '44px' : undefined,
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  borderRadius: '3px',
                  backgroundColor: showProblemPanel ? themeStyles.bgButtonActive : themeStyles.bgButton,
                  color: showProblemPanel ? themeStyles.textOnPrimary : themeStyles.textSecondary,
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
              >
                题目
              </button>
            )}
            {(pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0 || Object.keys(pendingCardFaceChanges).length > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) && (
              <span style={{ fontSize: '12px', color: themeStyles.textSecondary }}>
                {pendingChanges.size > 0 && `${pendingChanges.size} 个文件已修改`}
                {pendingChanges.size > 0 && (pendingDragChanges.size > 0 || pendingRenames.size > 0 || Object.keys(pendingCardFaceChanges).length > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) && '，'}
                {Object.keys(pendingCardFaceChanges).length > 0 && `${Object.keys(pendingCardFaceChanges).length} 个卡面已修改`}
                {Object.keys(pendingCardFaceChanges).length > 0 && (pendingDragChanges.size > 0 || pendingRenames.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) && '，'}
                {pendingDragChanges.size > 0 && `${pendingDragChanges.size} 个拖动操作`}
                {pendingDragChanges.size > 0 && (pendingRenames.size > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) && '，'}
                {pendingRenames.size > 0 && `${pendingRenames.size} 个重命名`}
                {(pendingRenames.size > 0 || pendingChanges.size > 0 || pendingDragChanges.size > 0) && (pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) && '，'}
                {pendingNewProblemCardIds.size > 0 && `${pendingNewProblemCardIds.size} 个题目新建`}
                {pendingNewProblemCardIds.size > 0 && (pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) && '，'}
                {pendingEditedProblemIds.size > 0 && `${pendingEditedProblemIds.size} 个题目更改`}
                {pendingEditedProblemIds.size > 0 && pendingDeleteProblemIds.size > 0 && '，'}
                {pendingDeleteProblemIds.size > 0 && `${pendingDeleteProblemIds.size} 个题目删除`}
              </span>
            )}
            <button
              onClick={() => {
                console.log('[保存按钮] 点击保存，pendingProblemCardIds:', Array.from(pendingProblemCardIds));
                handleSaveAll();
              }}
              disabled={isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0 && pendingDeleteProblemIds.size === 0)}
              style={{
                padding: isMobile ? '10px 12px' : '4px 12px',
                minHeight: isMobile ? '44px' : undefined,
                border: `1px solid ${themeStyles.borderSecondary}`,
                borderRadius: '3px',
                backgroundColor: (pendingChanges.size > 0 || pendingDragChanges.size > 0 || pendingRenames.size > 0 || pendingCreatesCount > 0 || pendingDeletes.size > 0 || Object.keys(pendingCardFaceChanges).length > 0 || pendingNewProblemCardIds.size > 0 || pendingEditedProblemIds.size > 0 || pendingDeleteProblemIds.size > 0) ? themeStyles.success : (theme === 'dark' ? '#555' : '#6c757d'),
                color: themeStyles.textOnPrimary,
                cursor: (isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0 && pendingDeleteProblemIds.size === 0)) ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: '500',
                opacity: (isCommitting || (pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0 && pendingDeleteProblemIds.size === 0)) ? 0.6 : 1,
              }}
              title={(pendingChanges.size === 0 && pendingDragChanges.size === 0 && pendingRenames.size === 0 && pendingCreatesCount === 0 && pendingDeletes.size === 0 && Object.keys(pendingCardFaceChanges).length === 0 && pendingNewProblemCardIds.size === 0 && pendingEditedProblemIds.size === 0 && pendingDeleteProblemIds.size === 0) ? i18n('No pending changes') : i18n('Save all changes')}
            >
              {isCommitting ? i18n('Saving...') : `${i18n('Save changes')} (${pendingChanges.size + pendingDragChanges.size + pendingRenames.size + pendingCreatesCount + pendingDeletes.size + Object.keys(pendingCardFaceChanges).length + pendingNewProblemCardIds.size + pendingEditedProblemIds.size + pendingDeleteProblemIds.size})`}
            </button>
          </div>
          )}
        </div>

        {/* 今日贡献：紧凑卡片条 */}
        {(() => {
          const todayContribution = contributionData.todayContribution;
          const todayAll = contributionData.todayContributionAllDomains;
          const domainId = (window as any).UiContext?.domainId || (window as any).UiContext?.base?.domainId;
          const uid = (window as any).UserContext?._id;
          const contributionLink = typeof uid === 'number' && domainId
            ? `/d/${domainId}/user/${uid}?tab=contributions`
            : null;
          const chars = (t: typeof todayContribution) => (t.nodeChars ?? 0) + (t.cardChars ?? 0) + (t.problemChars ?? 0);
          const formatNum = (n: number) => n.toLocaleString('en-US');
          const cardStyle: React.CSSProperties = {
            padding: isMobile ? '8px 10px' : '12px 16px',
            borderRadius: isMobile ? '6px' : '10px',
            border: `1px solid ${themeStyles.borderSecondary}`,
            backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            flex: 1,
            minWidth: 0,
          };
          const Stat = ({ label, value, color }: { label: string; value: string; color: string }) => (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: isMobile ? '2px' : '4px' }}>
              <span style={{ fontSize: isMobile ? '10px' : '11px', color: themeStyles.textSecondary, fontWeight: 500 }}>{label}</span>
              <span style={{ color, fontWeight: 600, fontSize: isMobile ? '12px' : '14px' }}>{value}</span>
            </span>
          );
          return (
            <div
              style={{
                flexShrink: 0,
                padding: isMobile ? '6px 10px 8px' : '12px 16px',
                borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                backgroundColor: themeStyles.bgSecondary,
                display: 'flex',
                flexDirection: 'column',
                gap: isMobile ? '6px' : '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
                <span style={{ fontSize: isMobile ? '12px' : '13px', fontWeight: 600, color: themeStyles.textPrimary }}>
                  {i18n('Today\'s contribution')}
                </span>
                {contributionLink && (
                  <a href={contributionLink} style={{ fontSize: isMobile ? '11px' : '12px', color: themeStyles.accent, textDecoration: 'none' }}>
                    {i18n('View all')} →
                  </a>
                )}
              </div>
              <div style={{ display: 'flex', gap: isMobile ? '8px' : '12px', flexWrap: 'wrap' }}>
                <div style={cardStyle}>
                  <div style={{ fontSize: isMobile ? '10px' : '11px', color: themeStyles.textSecondary, marginBottom: isMobile ? '4px' : '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {i18n('Total today (all domains)')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? '8px 12px' : '12px 16px', alignItems: 'center' }}>
                    <Stat label={i18n('Nodes')} value={formatNum(todayAll.nodes)} color={themeStyles.statNode} />
                    <Stat label={i18n('Cards')} value={formatNum(todayAll.cards)} color={themeStyles.statCard} />
                    <Stat label={i18n('Problems')} value={formatNum(todayAll.problems)} color={themeStyles.statProblem} />
                    <Stat label={i18n('Chars')} value={formatNum(chars(todayAll))} color={themeStyles.textSecondary} />
                  </div>
                </div>
                <div style={cardStyle}>
                  <div style={{ fontSize: isMobile ? '10px' : '11px', color: themeStyles.textSecondary, marginBottom: isMobile ? '4px' : '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {i18n('This domain today')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? '8px 12px' : '12px 16px', alignItems: 'center' }}>
                    <Stat label={i18n('Nodes')} value={formatNum(todayContribution.nodes)} color={themeStyles.statNode} />
                    <Stat label={i18n('Cards')} value={formatNum(todayContribution.cards)} color={themeStyles.statCard} />
                    <Stat label={i18n('Problems')} value={formatNum(todayContribution.problems)} color={themeStyles.statProblem} />
                    <Stat label={i18n('Chars')} value={formatNum(chars(todayContribution))} color={themeStyles.textSecondary} />
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Editor + problems */}
        <div 
          id="editor-container"
          style={{ flex: 1, minHeight: 0, padding: '0', overflow: 'hidden', position: 'relative', backgroundColor: themeStyles.bgPrimary, display: 'flex', flexDirection: 'column' }}
        >
          {/* Markdown editor */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {selectedFile && selectedFile.type === 'card' ? (
              <div 
                id={`editor-wrapper-${selectedFile.id}`}
                style={{ width: '100%', height: '100%', position: 'relative' }}
              >
                <textarea
                  key={selectedFile.id}
                  ref={editorRef}
                  defaultValue={fileContent}
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    outline: 'none',
                    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, "source-code-pro", monospace',
                    fontSize: '14px',
                    lineHeight: '1.6',
                    resize: 'none',
                    padding: '16px',
                    boxSizing: 'border-box',
                    backgroundColor: themeStyles.bgPrimary,
                    color: themeStyles.textPrimary,
                  }}
                />
              </div>
            ) : (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: themeStyles.textSecondary,
                fontSize: '14px',
              }}>
                {selectedFile?.type === 'node' ? '节点不支持编辑，请在 EXPLORER 中重命名' : '请从左侧选择一个卡片'}
              </div>
            )}
          </div>

        </div>
      </div>

      {showProblemPanel && isMobile && (
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setShowProblemPanel(false)}
          aria-hidden
        />
      )}
      {showProblemPanel && selectedFile?.type === 'card' && (
        <div style={{
          ...(isMobile
            ? { position: 'fixed' as const, right: 0, top: 0, bottom: 0, width: 'min(400px, 85vw)', zIndex: 1002, boxShadow: '-4px 0 16px rgba(0,0,0,0.15)', paddingTop: 'env(safe-area-inset-top, 0px)' }
            : { width: `${PROBLEM_PANEL_WIDTH}px`, height: '100%', flexShrink: 0 }),
          borderLeft: `1px solid ${themeStyles.borderPrimary}`,
          display: 'flex',
          flexDirection: 'column',
          background: themeStyles.bgPrimary,
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${themeStyles.borderPrimary}`,
            background: themeStyles.bgSecondary,
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span>本卡片的练习题</span>
            <button
              type="button"
              onClick={() => setShowProblemPanel(false)}
              style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: themeStyles.textTertiary }}
              aria-label="关闭"
            >
              &times;
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', minHeight: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '12px', color: themeStyles.textTertiary }}>支持本地单选题</span>
              <button
                type="button"
                onClick={() => setShowProblemForm(true)}
                style={{
                  padding: '2px 8px',
                  fontSize: '12px',
                  borderRadius: '3px',
                  border: '1px solid #0366d6',
                  background: '#0366d6',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                新建题目
              </button>
            </div>
            {(() => {
              const card = getSelectedCard();
              const problems = card?.problems || [];
              const cardIdStr = String(selectedFile?.cardId || '');
              const _ = originalProblemsVersion;
              const originalProblems = originalProblemsRef.current.get(cardIdStr) || new Map();
              if (!problems.length) {
                return (
                  <div style={{ fontSize: '12px', color: '#6a737d', marginBottom: '8px' }}>
                    还没有为本卡片创建题目，可以点击「新建题目」按钮来添加。
                  </div>
                );
              }
              return (
                <div style={{ marginBottom: '8px' }}>
                  {problems.map((p, index) => {
                    const isNew = newProblemIds.has(p.pid) || !originalProblems.has(p.pid);
                    const originalProblem = originalProblems.get(p.pid);
                    const isEdited = editedProblemIds.has(p.pid) || (originalProblem && (
                      originalProblem.stem !== p.stem ||
                      JSON.stringify(originalProblem.options) !== JSON.stringify(p.options) ||
                      originalProblem.answer !== p.answer ||
                      (originalProblem.analysis || '') !== (p.analysis || '')
                    ));
                    const isPendingDelete = pendingDeleteProblemIds.has(p.pid);
                    let borderColor = '#e1e4e8';
                    let borderStyle = 'solid';
                    if (isPendingDelete) { borderColor = '#f44336'; borderStyle = 'dashed'; }
                    else if (isNew) { borderColor = '#4caf50'; borderStyle = 'dashed'; }
                    else if (isEdited) { borderColor = '#ff9800'; borderStyle = 'dashed'; }
                    return (
                      <EditableProblem
                        key={p.pid}
                        problem={p}
                        index={index}
                        cardId={cardIdStr}
                        borderColor={borderColor}
                        borderStyle={borderStyle}
                        isNew={isNew}
                        isEdited={isEdited}
                        isPendingDelete={isPendingDelete}
                        originalProblem={originalProblem}
                        docId={docId}
                        getBaseUrl={getBaseUrl}
                        themeStyles={themeStyles}
                        onUpdate={(updatedProblem) => {
                          const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                          const nodeId = selectedFile?.nodeId || '';
                          const nodeCards: Card[] = nodeCardsMap[nodeId] || [];
                          const cardIndex = nodeCards.findIndex((c: Card) => c.docId === selectedFile?.cardId);
                          if (cardIndex >= 0) {
                            const existingProblems = nodeCards[cardIndex].problems || [];
                            const problemIndex = existingProblems.findIndex(prob => prob.pid === p.pid);
                            if (problemIndex >= 0) {
                              existingProblems[problemIndex] = updatedProblem;
                              nodeCards[cardIndex] = { ...nodeCards[cardIndex], problems: existingProblems };
                              (window as any).UiContext.nodeCardsMap = { ...nodeCardsMap };
                              setNodeCardsMapVersion(prev => prev + 1);
                              if (isNew) setNewProblemIds(prev => new Set(prev).add(p.pid));
                              else setEditedProblemIds(prev => new Set(prev).add(p.pid));
                              if (cardIdStr && !cardIdStr.startsWith('temp-card-')) {
                                setPendingProblemCardIds(prev => { const next = new Set(prev); next.add(cardIdStr); return next; });
                                if (isNew) setPendingNewProblemCardIds(prev => { const next = new Set(prev); next.add(cardIdStr); return next; });
                                else {
                                  setPendingEditedProblemIds(prev => {
                                    const next = new Map(prev);
                                    if (!next.has(cardIdStr)) next.set(cardIdStr, new Set());
                                    next.get(cardIdStr)!.add(p.pid);
                                    return next;
                                  });
                                  setPendingNewProblemCardIds(prev => { const next = new Set(prev); next.delete(cardIdStr); return next; });
                                }
                              }
                            }
                          }
                        }}
                        onDelete={() => {
                          setPendingDeleteProblemIds(prev => { const next = new Map(prev); next.set(p.pid, cardIdStr); return next; });
                          if (cardIdStr && !cardIdStr.startsWith('temp-card-')) {
                            setPendingProblemCardIds(prev => { const next = new Set(prev); next.add(cardIdStr); return next; });
                          }
                          setNewProblemIds(prev => { const next = new Set(prev); next.delete(p.pid); return next; });
                          setEditedProblemIds(prev => { const next = new Set(prev); next.delete(p.pid); return next; });
                          setPendingNewProblemCardIds(prev => { const next = new Set(prev); next.delete(cardIdStr); return next; });
                          setPendingEditedProblemIds(prev => {
                            const next = new Map(prev);
                            const editedSet = next.get(cardIdStr);
                            if (editedSet) { editedSet.delete(p.pid); if (editedSet.size === 0) next.delete(cardIdStr); }
                            return next;
                          });
                          setNodeCardsMapVersion(prev => prev + 1);
                          setOriginalProblemsVersion(prev => prev + 1);
                        }}
                      />
                    );
                  })}
                </div>
              );
            })()}
            {showProblemForm && (
              <div style={{ borderTop: '1px dashed #e1e4e8', paddingTop: '8px', marginTop: '4px' }}>
                <div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>生成新的单选题</div>
                <div style={{ marginBottom: '4px', display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => handleGenerateProblemWithAgent()}
                    disabled={isGeneratingProblemWithAgent || isSavingProblem}
                    style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid #28a745',
                      background: isGeneratingProblemWithAgent ? '#c0dfff' : '#28a745',
                      color: '#fff',
                      fontSize: '11px',
                      cursor: (isGeneratingProblemWithAgent || isSavingProblem) ? 'not-allowed' : 'pointer',
                      flex: 1,
                    }}
                  >
                    {isGeneratingProblemWithAgent ? '生成中...' : '通过Agent生成'}
                  </button>
                </div>
                <div style={{ marginBottom: '4px' }}>
                  <textarea
                    value={problemStem}
                    onChange={e => setProblemStem(e.target.value)}
                    placeholder="题干或输入要求让Agent生成"
                    style={{ width: '100%', minHeight: '40px', resize: 'vertical', fontSize: '12px', padding: '4px 6px', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '4px' }}>
                  {problemOptions.map((opt, index) => (
                    <input
                      key={index}
                      value={opt}
                      onChange={e => { const next = [...problemOptions]; next[index] = e.target.value; setProblemOptions(next); }}
                      placeholder={`选项 ${String.fromCharCode(65 + index)}`}
                      style={{ fontSize: '12px', padding: '3px 6px', boxSizing: 'border-box' }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', fontSize: '12px' }}>
                  <span style={{ marginRight: 4 }}>{i18n('Correct answer')}:</span>
                  {problemOptions.map((_, index) => (
                    <label key={index} style={{ marginRight: 6, cursor: 'pointer' }}>
                      <input type="radio" name="problem-answer" checked={problemAnswer === index} onChange={() => setProblemAnswer(index)} style={{ marginRight: 2 }} />
                      {String.fromCharCode(65 + index)}
                    </label>
                  ))}
                </div>
                <div style={{ marginBottom: '4px' }}>
                  <textarea
                    value={problemAnalysis}
                    onChange={e => setProblemAnalysis(e.target.value)}
                    placeholder={i18n('Analysis (optional)')}
                    style={{ width: '100%', minHeight: '32px', resize: 'vertical', fontSize: '12px', padding: '4px 6px', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => { setShowProblemForm(false); setProblemStem(''); setProblemOptions(['', '', '', '']); setProblemAnswer(0); setProblemAnalysis(''); }}
                    disabled={isSavingProblem}
                    style={{ padding: '4px 8px', borderRadius: '4px', border: `1px solid ${themeStyles.borderSecondary}`, background: themeStyles.bgButton, color: themeStyles.textPrimary, fontSize: '12px', cursor: isSavingProblem ? 'not-allowed' : 'pointer' }}
                  >
                    {i18n('Cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateSingleProblem}
                    disabled={isSavingProblem}
                    style={{ padding: '4px 10px', borderRadius: '4px', border: `1px solid ${themeStyles.accent}`, background: isSavingProblem ? themeStyles.textTertiary : themeStyles.accent, color: themeStyles.textOnPrimary, fontSize: '12px', cursor: isSavingProblem ? 'not-allowed' : 'pointer' }}
                  >
                    {isSavingProblem ? '生成中...' : '生成单选题'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Skill mode: right sidebar, click tool to copy params */}
      {basePath === 'base/skill' && (
        <div style={{
          width: '280px',
          flexShrink: 0,
          borderLeft: `1px solid ${themeStyles.borderPrimary}`,
          backgroundColor: themeStyles.bgSecondary,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${themeStyles.borderPrimary}`,
            fontSize: '12px',
            fontWeight: '600',
            color: themeStyles.textSecondary,
            backgroundColor: themeStyles.bgPrimary,
          }}>
            工具
          </div>
          <div style={{ padding: '8px 12px', fontSize: '11px', color: themeStyles.textTertiary, borderBottom: `1px solid ${themeStyles.borderPrimary}` }}>
            点击工具可复制「工具名 + 参数」到剪贴板
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
            {domainToolsLoading ? (
              <div style={{ padding: '12px 16px', fontSize: '12px', color: themeStyles.textSecondary }}>加载中...</div>
            ) : domainTools.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: '12px', color: themeStyles.textSecondary }}>当前域下暂无工具。</div>
            ) : (
              domainTools.map((tool: any) => {
                const toolKey = tool.toolKey || tool.name || '';
                const label = tool.name || tool.toolKey || '';
                const serverLabel = tool.edgeName || '';
                const schema = tool.inputSchema;
                const params: Array<{ name: string; desc?: string; defaultVal?: string }> = [];
                if (schema?.properties && typeof schema.properties === 'object') {
                  Object.entries(schema.properties).forEach(([k, v]: [string, any]) => {
                    params.push({
                      name: k,
                      desc: v?.description,
                      defaultVal: v?.default != null ? String(v.default) : undefined,
                    });
                  });
                }
                const buildCopyPayload = () => {
                  const args: Record<string, string> = {};
                  params.forEach((p) => {
                    args[p.name] = p.defaultVal ?? '';
                  });
                  return JSON.stringify({ tool: toolKey, arguments: args }, null, 2);
                };
                const copyPayload = toolKey ? (params.length > 0 ? buildCopyPayload() : JSON.stringify({ tool: toolKey, arguments: {} }, null, 2)) : '';
                return (
                  <div
                    key={tool.tid != null ? `edge-${tool.tid}-${tool.edgeToken}` : `system-${tool.toolKey}`}
                    title={copyPayload ? '点击复制工具参数' : ''}
                    onClick={() => {
                      if (!copyPayload) return;
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(copyPayload).then(() => {
                          Notification.success('已复制到剪贴板');
                        }).catch(() => {
                          Notification.error(i18n('Copy failed'));
                        });
                      } else {
                        Notification.error('剪贴板不可用');
                      }
                    }}
                    style={{
                      padding: '10px 16px',
                      fontSize: '12px',
                      color: themeStyles.textPrimary,
                      cursor: copyPayload ? 'pointer' : 'default',
                      borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                    }}
                    onMouseEnter={(e) => {
                      if (copyPayload) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{label}</div>
                    {serverLabel && (
                      <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginTop: '2px' }}>{serverLabel}</div>
                    )}
                    {params.length > 0 && (
                      <div style={{ marginTop: '6px', fontSize: '11px', color: themeStyles.textSecondary }}>
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>参数：</div>
                        {params.map((p) => (
                          <div key={p.name} style={{ marginLeft: '4px', marginBottom: '2px' }}>
                            <code style={{ fontSize: '10px' }}>{p.name}</code>
                            {p.desc && <span style={{ marginLeft: '4px' }}>— {p.desc}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {showAIChat && isMobile && (
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setShowAIChat(false)}
          aria-hidden
        />
      )}
      {showAIChat && !isMobile && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizing(true);
            resizeStartXRef.current = e.clientX;
            resizeStartWidthRef.current = chatPanelWidth;
          }}
          style={{
            width: '4px',
            height: '100%',
            background: isResizing ? themeStyles.accent : themeStyles.borderPrimary,
            cursor: 'col-resize',
            position: 'relative',
            flexShrink: 0,
            transition: isResizing ? 'none' : 'background 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (!isResizing) {
              e.currentTarget.style.background = themeStyles.textSecondary;
            }
          }}
          onMouseLeave={(e) => {
            if (!isResizing) {
              e.currentTarget.style.background = themeStyles.borderPrimary;
            }
          }}
        >
          <div style={{
            position: 'absolute',
            left: '-2px',
            top: 0,
            width: '8px',
            height: '100%',
            cursor: 'col-resize',
          }} />
        </div>
      )}

      {showAIChat && (
        <div style={{
          ...(isMobile
            ? {
                position: 'fixed' as const,
                right: 0,
                top: 0,
                bottom: 0,
                width: 'min(400px, 85vw)',
                zIndex: 1002,
                boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
                paddingTop: 'env(safe-area-inset-top, 0px)',
              }
            : {
                width: `${chatPanelWidth}px`,
                height: '100%',
                flexShrink: 0,
                transition: isResizing ? 'none' : 'width 0.3s ease',
              }),
          borderLeft: `1px solid ${themeStyles.borderPrimary}`,
          display: 'flex',
          flexDirection: 'column',
          background: themeStyles.bgPrimary,
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${themeStyles.borderPrimary}`,
            background: themeStyles.bgSecondary,
            fontWeight: 'bold',
            color: themeStyles.textPrimary,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span>AI 助手</span>
            <button
              onClick={() => setShowAIChat(false)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer',
                color: themeStyles.textTertiary,
              }}
            >
              &times;
            </button>
          </div>
          
          <div 
            ref={chatMessagesContainerRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              backgroundColor: themeStyles.bgPrimary,
            }}
          >
            {chatMessages.length === 0 && (
              <div style={{
                textAlign: 'center',
                color: themeStyles.textTertiary,
                padding: '20px',
                fontSize: '14px',
              }}>
                <p>你好！我是 AI 助手，可以帮助你操作知识库。</p>
                <p style={{ marginTop: '8px', fontSize: '12px' }}>例如：</p>
                <ul style={{ textAlign: 'left', marginTop: '8px', fontSize: '12px', color: themeStyles.textSecondary }}>
                  <li>"在根节点下创建一个名为 i18n('New node') 的节点"</li>
                  <li>"在 '节点名' 下创建一个卡片，标题为 i18n('New card')"</li>
                  <li>"将 '节点A' 移动到 '节点B' 下"</li>
                  <li>"将 '节点A' 重命名为 '新名称'"</li>
                  <li>"删除 '节点A'"</li>
                </ul>
              </div>
            )}
            {chatMessages.map((msg, index) => {
              if (msg.role === 'operation') {
                
                return (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div
                      onClick={() => {
                        setChatMessages(prev => {
                          const newMessages = [...prev];
                          newMessages[index] = {
                            ...newMessages[index],
                            isExpanded: !newMessages[index].isExpanded,
                          };
                          return newMessages;
                        });
                      }}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        background: '#e3f2fd',
                        border: '1px solid #90caf9',
                        color: '#1976d2',
                        maxWidth: '85%',
                        fontSize: '14px',
                        cursor: 'pointer',
                        userSelect: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      <span style={{ fontSize: '16px' }}>⚙️</span>
                      <span>{msg.content}</span>
                      <span style={{ fontSize: '12px', opacity: 0.7 }}>
                        {msg.isExpanded ? '▼' : '▶'}
                      </span>
                    </div>
                    {msg.isExpanded && msg.operations && (
                      <div style={{
                        marginTop: '8px',
                        padding: '12px',
                        background: '#f5f5f5',
                        borderRadius: '8px',
                        maxWidth: '85%',
                        fontSize: '12px',
                        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
                        overflowX: 'auto',
                      }}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {JSON.stringify({ operations: msg.operations }, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              }
              
              
              return (
                <div
                  key={index}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: msg.role === 'user' ? themeStyles.accent : themeStyles.bgSecondary,
                    color: msg.role === 'user' ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                    maxWidth: '85%',
                    fontSize: '14px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {msg.role === 'user' && msg.references && msg.references.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                        {msg.references.map((ref, refIndex) => (
                          <div
                            key={refIndex}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 8px',
                              background: 'rgba(255, 255, 255, 0.2)',
                              borderRadius: '4px',
                              fontSize: '12px',
                            }}
                          >
                            <span style={{ fontSize: '12px' }}>
                              {ref.type === 'node' ? '📂' : '📄'}
                            </span>
                            <span style={{ fontWeight: '500' }}>{ref.name}</span>
                            <span style={{ opacity: 0.8, fontSize: '11px' }}>
                              {ref.path.join(' > ')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.content}
                  </div>
                </div>
              );
            })}
            {isChatLoading && (
              <div style={{
                padding: '8px 12px',
                borderRadius: '8px',
                background: themeStyles.bgSecondary,
                color: themeStyles.textTertiary,
                fontSize: '14px',
              }}>
                正在思考...
              </div>
            )}
            <div ref={chatMessagesEndRef} />
          </div>

          <div style={{
            padding: '12px',
            borderTop: `1px solid ${themeStyles.borderPrimary}`,
            background: themeStyles.bgSecondary,
          }}>
            {/* Reference tags */}
            {chatInputReferences.length > 0 && (
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                marginBottom: '8px',
                padding: '6px',
                background: themeStyles.bgPrimary,
                borderRadius: '4px',
                border: `1px solid ${themeStyles.borderPrimary}`,
                minHeight: '32px',
              }}>
                {chatInputReferences.map((ref, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 8px',
                      background: themeStyles.bgDragOver,
                      borderRadius: '4px',
                      fontSize: '12px',
                      border: `1px solid ${themeStyles.accent}`,
                    }}
                  >
                    <span style={{ fontSize: '12px' }}>
                      {ref.type === 'node' ? '📂' : '📄'}
                    </span>
                    <span style={{ fontWeight: '500', color: themeStyles.accent }}>{ref.name}</span>
                    <span style={{ opacity: 0.7, fontSize: '11px', color: themeStyles.accent }}>
                      {ref.path.join(' > ')}
                    </span>
                    <button
                      onClick={() => {
                        
                        const placeholder = `@${ref.name}`;
                        const startIndex = ref.startIndex;
                        const endIndex = ref.endIndex;
                        
                        
                        const newText = chatInput.slice(0, startIndex) + chatInput.slice(endIndex);
                        
                        
                        setChatInputReferences(prev => {
                          const newRefs = prev
                            .filter((_, i) => i !== index)
                            .map(r => {
                              
                              if (r.startIndex > startIndex) {
                                return {
                                  ...r,
                                  startIndex: r.startIndex - placeholder.length,
                                  endIndex: r.endIndex - placeholder.length,
                                };
                              }
                              return r;
                            });
                          return newRefs;
                        });
                        
                        setChatInput(newText);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '0',
                        marginLeft: '4px',
                        fontSize: '14px',
                        color: '#1976d2',
                        lineHeight: '1',
                      }}
                      title="移除引用"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={chatInput}
              onChange={(e) => {
                const newText = e.target.value;
                const oldText = chatInput;
                
                
                if (newText.length !== oldText.length) {
                  const diff = newText.length - oldText.length;
                  const selectionStart = e.currentTarget.selectionStart;
                  
                  setChatInputReferences(prev => {
                    return prev.map(ref => {
                      
                      if (selectionStart <= ref.startIndex) {
                        return {
                          ...ref,
                          startIndex: ref.startIndex + diff,
                          endIndex: ref.endIndex + diff,
                        };
                      }
                      
                      else if (selectionStart > ref.startIndex && selectionStart < ref.endIndex) {
                        
                        return null as any;
                      }
                      return ref;
                    }).filter(ref => ref !== null && ref.startIndex >= 0 && ref.endIndex <= newText.length);
                  });
                }
                
                setChatInput(newText);
              }}
              onPaste={handleAIChatPaste}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAIChatSend();
                }
              }}
              placeholder="输入消息... (Shift+Enter换行，Enter发送，粘贴复制的节点/卡片会自动添加引用)"
              rows={3}
              disabled={isChatLoading}
              style={{
                width: '100%',
                padding: '8px',
                border: `1px solid ${themeStyles.borderPrimary}`,
                borderRadius: '4px',
                fontSize: '14px',
                resize: 'none',
                fontFamily: 'inherit',
                backgroundColor: themeStyles.bgPrimary,
                color: themeStyles.textPrimary,
              }}
            />
            <button
              onClick={handleAIChatSend}
              disabled={!chatInput.trim() || isChatLoading}
              style={{
                marginTop: '8px',
                width: '100%',
                padding: '8px',
                border: 'none',
                borderRadius: '4px',
                background: (!chatInput.trim() || isChatLoading) ? themeStyles.textTertiary : themeStyles.accent,
                color: themeStyles.textOnPrimary,
                cursor: (!chatInput.trim() || isChatLoading) ? 'not-allowed' : 'pointer',
                fontWeight: 'bold',
              }}
            >
              发送
            </button>
          </div>
        </div>
      )}

      {!isMobile && (
        <div
          style={{
            width: '32px',
            flexShrink: 0,
            borderLeft: `1px solid ${themeStyles.borderPrimary}`,
            backgroundColor: themeStyles.bgSecondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <button
            type="button"
            onClick={() => setShowAIChat((prev) => !prev)}
            aria-label="AI"
            title={showAIChat ? '隐藏 AI 助手' : '显示 AI 助手'}
            style={{
              writingMode: 'vertical-rl',
              textOrientation: 'mixed',
              padding: '12px 6px',
              fontSize: '12px',
              fontWeight: '600',
              letterSpacing: '0.05em',
              border: 'none',
              borderRadius: '4px',
              background: showAIChat ? themeStyles.accent : themeStyles.bgButton,
              color: showAIChat ? themeStyles.textOnPrimary : themeStyles.textSecondary,
              cursor: 'pointer',
            }}
          >
            AI
          </button>
        </div>
      )}
    </div>
  );
}


const getBaseUrl = (path: string, docId: string): string => {
  const domainId = (window as any).UiContext?.domainId || 'system';
  return `/d/${domainId}/base/${docId}${path}`;
};

const page = new NamedPage(['base_editor', 'base_skill_editor', 'base_skill_editor_branch'], async (pageName) => {
  try {
    
    const isSkill = pageName === 'base_skill_editor' || pageName === 'base_skill_editor_branch';
    const containerId = isSkill ? '#skill-editor-mode' : '#base-editor-mode';
    const $container = $(containerId);
    if (!$container.length) {
      return;
    }

    const domainId = (window as any).UiContext?.domainId || 'system';
    const docId = $container.data('doc-id') || $container.attr('data-doc-id') || '';

    
    let initialData: BaseDoc;
    try {
      
      const apiPath = isSkill ? `/d/${domainId}/base/skill/data` : `/d/${domainId}/base/data`;
      const response = await request.get(apiPath);
      initialData = response;
      
      if (!initialData.docId) {
        initialData.docId = docId || '';
      }
    } catch (error: any) {
      Notification.error(`加载${isSkill ? 'Skills' : '知识库'}失败: ` + (error.message || '未知错误'));
      return;
    }

    ReactDOM.render(
      <BaseEditorMode docId={initialData.docId || ''} initialData={initialData} basePath={isSkill ? 'base/skill' : 'base'} />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize editor mode:', error);
    Notification.error('初始化编辑器模式失败: ' + (error.message || '未知错误'));
  }
});

export default page;


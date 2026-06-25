import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { i18n } from 'vj/utils';
import type { BaseDoc, BaseNode, Card } from './types';

export function SortWindow({
  nodeId,
  base,
  docId,
  getBaseUrl,
  onClose,
  onSave,
  nodeCardsMapVersion,
  themeStyles,
  theme,
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

  const getNodeDisplayName = useCallback((node: BaseNode) => {
    const raw = node.text ?? (node as any).label ?? (node as any).name;
    return (raw != null && String(raw).trim() !== '') ? String(raw).trim() : i18n('Unnamed Node');
  }, []);

  const childNodes = useMemo(() => {
    return base.edges
      .filter(e => e.source === nodeId)
      .map(e => {
        const node = base.nodes.find(n => n.id === e.target);
        return node ? {
          id: node.id,
          name: getNodeDisplayName(node),
          order: node.order || 0,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; name: string; order: number }>;
  }, [base.edges, base.nodes, nodeId, getNodeDisplayName]);

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

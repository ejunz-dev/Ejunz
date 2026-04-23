import $ from 'jquery';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request, i18n } from 'vj/utils';

interface BaseNode {
  id: string;
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  expandedOutline?: boolean;
  level?: number;
  order?: number;
  style?: Record<string, any>;
  data?: Record<string, any>;
}

interface BaseEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: Record<string, any>;
  type?: 'straight' | 'curved' | 'bezier';
  color?: string;
  width?: number;
}

interface BaseDoc {
  docId: string;
  bid: number;
  title: string;
  content: string;
  nodes: BaseNode[];
  edges: BaseEdge[];
  layout?: {
    type: 'hierarchical' | 'force' | 'manual';
    direction?: 'LR' | 'RL' | 'TB' | 'BT';
    spacing?: { x: number; y: number };
    config?: Record<string, any>;
  };
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
  theme?: {
    primaryColor?: string;
    backgroundColor?: string;
    nodeStyle?: Record<string, any>;
    edgeStyle?: Record<string, any>;
  };
  owner: number;
  createdAt: string;
  updateAt: string;
  views: number;
  githubRepo?: string;
  branches?: string[];
  currentBranch?: string;
}

// Card-mounted file info (from backend)
interface CardFileInfo {
  _id: string;
  name: string;
  size: number;
  lastModified?: Date | string;
}


interface Card {
  docId: string;
  cid: number;
  title: string;
  content: string;
  updateAt: string;
  createdAt?: string;
  order?: number;
  nodeId?: string;
  files?: CardFileInfo[];
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


interface ReactFlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: {
    label?: string;
    originalNode: BaseNode;
    [key: string]: any;
  };
}

interface ReactFlowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: {
    originalEdge: BaseEdge;
    [key: string]: any;
  };
}

const OutlineView = ({
  nodes,
  edges,
  onToggleExpand,
  onNodeClick,
  selectedNodeId,
  rootNodeId,
  basePath = 'base',
}: {
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
  onToggleExpand: (nodeId: string) => void;
  onNodeClick: (nodeId: string) => void;
  selectedNodeId: string | null;
  rootNodeId?: string | null;
  basePath?: string;
}) => {
 
  const [expandedNodesOutline, setExpandedNodesOutline] = useState<Set<string>>(() => {
   
    const allExpanded = new Set<string>();
    nodes.forEach(node => {
      allExpanded.add(node.id);
    });
    return allExpanded;
  });
  
 
  const handleToggleExpand = useCallback((nodeId: string) => {
    setExpandedNodesOutline(prev => {
     
      const newSet = new Set(prev);
      const wasExpanded = newSet.has(nodeId);
      if (wasExpanded) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
     
      return new Set(newSet);
    });
   
  }, []);
  
 
  const getStorageKey = useCallback(() => {
    const docId = (window as any).UiContext?.base?.docId;
    const bid = (window as any).UiContext?.base?.bid;
    const domainId = (window as any).UiContext?.domainId || 'system';
    if (docId) {
      return `base_cards_expanded_${domainId}_${docId}`;
    } else if (bid) {
      return `base_cards_expanded_${domainId}_bid_${bid}`;
    }
    return 'base_cards_expanded_default';
  }, []);

 
  const loadCardsExpandedState = useCallback((): Record<string, boolean> => {
    try {
      const key = getStorageKey();
      const saved = localStorage.getItem(key);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load cards expanded state:', e);
    }
    return {};
  }, [getStorageKey]);

 
  const saveCardsExpandedState = useCallback((state: Record<string, boolean>) => {
    try {
      const key = getStorageKey();
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save cards expanded state:', e);
    }
  }, [getStorageKey]);

 
  const [cardsExpanded, setCardsExpanded] = useState<Record<string, boolean>>(() => {
   
    const loaded = loadCardsExpandedState();
   
    const defaultExpanded: Record<string, boolean> = {};
    nodes.forEach(node => {
      const nodeCards = (window as any).UiContext?.nodeCardsMap?.[node.id] || [];
      if (nodeCards.length > 0) {
        defaultExpanded[node.id] = loaded[node.id] !== undefined ? loaded[node.id] : true;
      }
    });
    return { ...loaded, ...defaultExpanded };
  });

 
  const toggleCardsExpanded = useCallback((nodeId: string) => {
    setCardsExpanded(prev => {
      const newState = {
        ...prev,
        [nodeId]: !prev[nodeId],
      };
      saveCardsExpandedState(newState);
      return newState;
    });
  }, [saveCardsExpandedState]);

 
  useEffect(() => {
    setExpandedNodesOutline(prev => {
      const newSet = new Set(prev);
      let changed = false;
      nodes.forEach(node => {
        if (!newSet.has(node.id)) {
          newSet.add(node.id);
          changed = true;
        }
      });
      return changed ? newSet : prev;
    });
  }, [nodes]);

 
  useEffect(() => {
    const loaded = loadCardsExpandedState();
    const newState: Record<string, boolean> = {};
    nodes.forEach(node => {
      const nodeCards = (window as any).UiContext?.nodeCardsMap?.[node.id] || [];
      if (nodeCards.length > 0) {
        newState[node.id] = loaded[node.id] !== undefined ? loaded[node.id] : true;
      }
    });
    setCardsExpanded(prev => {
      const updated = { ...prev };
      let changed = false;
      nodes.forEach(node => {
        const nodeCards = (window as any).UiContext?.nodeCardsMap?.[node.id] || [];
        if (nodeCards.length > 0 && updated[node.id] === undefined) {
          updated[node.id] = loaded[node.id] !== undefined ? loaded[node.id] : true;
          changed = true;
        }
      });
      return changed ? updated : prev;
    });
  }, [nodes, loadCardsExpandedState]);

 
  const buildTree = useMemo(() => {
    const nodeMap = new Map<string, { node: ReactFlowNode; children: string[] }>();
    const rootNodes: string[] = [];

   
    nodes.forEach((node) => {
      nodeMap.set(node.id, { node, children: [] });
    });

   
    edges.forEach((edge) => {
      const parent = nodeMap.get(edge.source);
      if (parent) {
        parent.children.push(edge.target);
      }
    });

   
    nodeMap.forEach((nodeData) => {
      nodeData.children.sort((a, b) => {
        const nodeA = nodes.find(n => n.id === a);
        const nodeB = nodes.find(n => n.id === b);
        const originalNodeA = nodeA?.data.originalNode as BaseNode | undefined;
        const originalNodeB = nodeB?.data.originalNode as BaseNode | undefined;
        const orderA = originalNodeA?.order || 0;
        const orderB = originalNodeB?.order || 0;
        return orderA - orderB;
      });
    });

   
   
    if (rootNodeId && nodeMap.has(rootNodeId)) {
      rootNodes.push(rootNodeId);
    } else {
    nodes.forEach((node) => {
      const hasParent = edges.some((edge) => edge.target === node.id);
      if (!hasParent) {
        rootNodes.push(node.id);
      }
    });
    }

    return { nodeMap, rootNodes };
  }, [nodes, edges, rootNodeId]);

 
  const rootNodeInfo = useMemo(() => {
   
    const targetRootNodeId = rootNodeId || (buildTree.rootNodes.length > 0 ? buildTree.rootNodes[0] : null);
    if (!targetRootNodeId) return null;
    
    const rootNodeData = buildTree.nodeMap.get(targetRootNodeId);
    if (!rootNodeData) return null;
    const originalNode = rootNodeData.node.data.originalNode as BaseNode;
    return {
      id: targetRootNodeId,
      text: originalNode?.text || '未命名节点',
      children: rootNodeData.children,
    };
  }, [buildTree, rootNodeId]);

 
  const getAllVisibleChildren = useCallback((nodeId: string): string[] => {
    const nodeData = buildTree.nodeMap.get(nodeId);
    if (!nodeData) return [];
    
    const { node, children } = nodeData;
   
    const expanded = expandedNodesOutline.has(nodeId);
    
    if (!expanded || children.length === 0) return [];
    
    const visibleChildren: string[] = [];
    children.forEach((childId) => {
      visibleChildren.push(childId);
      visibleChildren.push(...getAllVisibleChildren(childId));
    });
    
    return visibleChildren;
  }, [buildTree, expandedNodesOutline]);

 
  const getNodeCards = useCallback((nodeId: string): Card[] => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const cards = nodeCardsMap[nodeId] || [];
   
    return [...cards].sort((a, b) => {
      const orderA = (a.order as number) || 0;
      const orderB = (b.order as number) || 0;
      return orderA - orderB;
    });
  }, []);

 
  const getCardUrl = useCallback((card: Card, nodeId: string): string => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    const branch = (window as any).UiContext?.currentBranch || 'main';
    const docId = (window as any).UiContext?.base?.docId;
    const bid = (window as any).UiContext?.base?.bid;
    
    const docSeg = docId != null && String(docId).trim()
      ? String(docId).trim()
      : (bid && String(bid).trim() ? String(bid).trim() : '');
    if (docSeg) {
      return `/d/${domainId}/${basePath}/${encodeURIComponent(docSeg)}/branch/${branch}/node/${nodeId}/cards?cardId=${card.docId}`;
    }
    return '#';
  }, [basePath]);

 
  const renderNodeTree = useCallback(
    (nodeId: string, level: number = 0, isLast: boolean = false, hasSiblings: boolean = false): JSX.Element | null => {
      const nodeData = buildTree.nodeMap.get(nodeId);
      if (!nodeData) return null;

      const { node, children } = nodeData;
      const originalNode = node.data.originalNode as BaseNode;
     
      const expanded = expandedNodesOutline.has(nodeId);
      const hasChildren = children.length > 0;
      const isSelected = selectedNodeId === nodeId;
      
     
      const cards = getNodeCards(nodeId);
      
     
      const childNodes = children.map(childId => {
        const childNodeData = buildTree.nodeMap.get(childId);
        if (!childNodeData) return null;
        const childOriginalNode = childNodeData.node.data.originalNode as BaseNode;
        return {
          id: childId,
          order: childOriginalNode?.order || 0,
        };
      }).filter(Boolean) as Array<{ id: string; order: number }>;
      
     
      const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
        ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: null })),
        ...cards.map(c => ({ 
          type: 'card' as const, 
          id: c.docId || String(c.cid || ''), 
          order: (c.order as number) || 0, 
          data: c 
        })),
      ];
      
      allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));

      return (
        <div key={nodeId} style={{ position: 'relative' }}>
          <div style={{ marginLeft: `${level * 24}px`, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 0',
                  cursor: 'pointer',
                  position: 'relative',
                  zIndex: 1,
                  width: '100%',
                }}
                onClick={() => onNodeClick(nodeId)}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = '#f5f5f5';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
    
                {hasChildren || cards.length > 0 ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleExpand(nodeId);
                    }}
                    style={{
                      width: '18px',
                      height: '18px',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: '4px',
                      padding: 0,
                      flexShrink: 0,
                      position: 'relative',
                      zIndex: 2,
                      color: '#666',
                    }}
                    title={expanded ? '折叠' : '展开'}
                  >
                    <span style={{ 
                      fontSize: '10px',
                      transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                      transition: 'transform 0.15s ease',
                      display: 'inline-block',
                      lineHeight: '1',
                    }}>
                      ▼
                    </span>
                  </button>
                ) : (
                  <div style={{ width: '22px', marginRight: '0px', flexShrink: 0 }} />
                )}
                
    
                <span style={{ 
                  marginRight: '8px',
                  color: '#666',
                  fontSize: '12px',
                  flexShrink: 0,
                  lineHeight: '1',
                }}>
                  •
                </span>
                
    
                <div
                  style={{
                    flex: 1,
                    color: isSelected ? '#1976d2' : (originalNode?.color || '#333'),
                    fontSize: `${originalNode?.fontSize || 14}px`,
                    fontWeight: isSelected ? '600' : 'normal',
                    lineHeight: '1.5',
                  }}
                >
                  {originalNode?.text || '未命名节点'}
                </div>
              </div>
            </div>
                </div>
                
          {expanded && allChildren.length > 0 && (
            <div style={{ position: 'relative', marginLeft: `${level * 24}px` }}>
  
                  <div
                    style={{
                  position: 'absolute',
                  left: '8px',
                  top: '0px',
                  bottom: '0px',
                  width: '1px',
                  backgroundColor: '#e0e0e0',
                  zIndex: 0,
                    }}
              />
              <div>
                {allChildren.map((item, index) => {
                  if (item.type === 'card') {
                   
                    const card = item.data as Card;
                    return (
                      <div
                        key={`card-${card.docId || card.cid}`}
                        style={{
                          marginLeft: '24px',
                          marginTop: '4px',
                          marginBottom: '4px',
                        }}
                      >
                        <div
                        onClick={(e) => {
                          e.stopPropagation();
                      window.open(getCardUrl(card, nodeId), '_blank');
                    }}
                    style={{
                      display: 'inline-block',
                      padding: '4px 8px',
                      fontSize: '12px',
                      color: '#1976d2',
                      textDecoration: 'none',
                      borderRadius: '4px',
                      backgroundColor: '#f0f7ff',
                      border: '1px solid #e3f2fd',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      maxWidth: 'fit-content',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#e3f2fd';
                      e.currentTarget.style.textDecoration = 'underline';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = '#f0f7ff';
                      e.currentTarget.style.textDecoration = 'none';
                    }}
                    title={card.title}
                  >
                    {card.title || '未命名卡片'}
              </div>
          </div>
                    );
                  } else {
                   
                    const childId = item.id;
                    const childNodeData = buildTree.nodeMap.get(childId);
                    if (!childNodeData) return null;
                    const isLastChild = index === allChildren.length - 1;
                    const childHasSiblings = allChildren.length > 1;
                  return renderNodeTree(childId, level + 1, isLastChild, childHasSiblings);
                  }
                })}
              </div>
            </div>
          )}
        </div>
      );
    },
    [buildTree, selectedNodeId, handleToggleExpand, onNodeClick, getNodeCards, getCardUrl, cardsExpanded, toggleCardsExpanded, expandedNodesOutline]
  );

  return (
    <div
      style={{
        padding: '24px 32px',
        backgroundColor: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        minHeight: '100%',
      }}
    >
      {!rootNodeInfo ? (
        <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '14px' }}>
          暂无节点
        </div>
      ) : (
        <>
          <div
            style={{
              fontSize: '20px',
              fontWeight: '600',
              color: '#333',
              marginBottom: '24px',
              paddingBottom: '16px',
              borderBottom: '1px solid #e0e0e0',
            }}
          >
            {rootNodeInfo.text}
          </div>
          
          {(() => {
            const rootCards = getNodeCards(rootNodeInfo.id);
            const rootChildNodes = rootNodeInfo.children.map(childId => {
              const childNodeData = buildTree.nodeMap.get(childId);
              if (!childNodeData) return null;
              const childOriginalNode = childNodeData.node.data.originalNode as BaseNode;
              return {
                id: childId,
                order: childOriginalNode?.order || 0,
              };
            }).filter(Boolean) as Array<{ id: string; order: number }>;
            
           
            const rootAllChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
              ...rootChildNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: null })),
              ...rootCards.map(c => ({ 
                type: 'card' as const, 
                id: c.docId || String(c.cid || ''), 
                order: (c.order as number) || 0, 
                data: c 
              })),
            ];
            
           
            rootAllChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
            
            if (rootAllChildren.length === 0) {
              return (
            <div style={{ textAlign: 'center', color: '#999', marginTop: '40px', fontSize: '14px' }}>
                  暂无内容
            </div>
              );
            }
            
            return (
            <div style={{ paddingLeft: '4px' }}>
                {rootAllChildren.map((item, index) => {
                  if (item.type === 'card') {
                   
                    const card = item.data as Card;
                    return (
                      <div
                        key={`card-${card.docId || card.cid}`}
                        style={{
                          marginLeft: '24px',
                          marginTop: '4px',
                          marginBottom: '4px',
                        }}
                      >
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(getCardUrl(card, rootNodeInfo.id), '_blank');
                          }}
                          style={{
                            display: 'inline-block',
                            padding: '4px 8px',
                            fontSize: '12px',
                            color: '#1976d2',
                            textDecoration: 'none',
                            borderRadius: '4px',
                            backgroundColor: '#f0f7ff',
                            border: '1px solid #e3f2fd',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            maxWidth: 'fit-content',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = '#e3f2fd';
                            e.currentTarget.style.textDecoration = 'underline';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = '#f0f7ff';
                            e.currentTarget.style.textDecoration = 'none';
                          }}
                          title={card.title}
                        >
                          {card.title || '未命名卡片'}
                        </div>
                      </div>
                    );
                  } else {
                   
                    const childId = item.id;
                    const isLastChild = index === rootAllChildren.length - 1;
                    const childHasSiblings = rootAllChildren.length > 1;
                    return renderNodeTree(childId, 0, isLastChild, childHasSiblings);
                  }
              })}
            </div>
            );
          })()}
        </>
      )}
    </div>
  );
};

export function BaseOutlineEditor({ docId, initialData, basePath = 'base' }: { docId: string | undefined; initialData: BaseDoc; basePath?: string }) {
  const [base, setBase] = useState<BaseDoc>(initialData);
  const [nodeCardsMap, setNodeCardsMap] = useState<Record<string, Card[]>>(
    () => (initialData as any).nodeCardsMap || (window as any).UiContext?.nodeCardsMap || {}
  );
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
 
  const isManualSelectionRef = useRef(false);
 
  const selectedFileIdRef = useRef<string | null>(null);
 
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
 
  const loadOutlineExpandedState = useCallback((): Set<string> => {
    const expanded = new Set<string>();
    if (initialData?.nodes) {
      initialData.nodes.forEach(node => {
       
        if (node.expandedOutline !== false) {
          expanded.add(node.id);
        }
      });
    }
    return expanded;
  }, [initialData?.nodes]);

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    return loadOutlineExpandedState();
  });

  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const [outlineStartBusy, setOutlineStartBusy] = useState(false);
  const [learnOutlineBusy, setLearnOutlineBusy] = useState(false);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setBranchDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

 
  const expandedNodesRef = useRef<Set<string>>(expandedNodes);
  const baseRef = useRef<BaseDoc>(base);
  
 
  useEffect(() => {
    expandedNodesRef.current = expandedNodes;
  }, [expandedNodes]);
  
  useEffect(() => {
    baseRef.current = base;
  }, [base]);

 
  useEffect(() => {
    if ((window as any).UiContext) {
      (window as any).UiContext.nodeCardsMap = nodeCardsMap;
    }
  }, [nodeCardsMap]);

  const refetchOutlineData = useCallback(async () => {
    const domainId = (window as any).UiContext?.domainId || 'system';
    const apiPath = basePath === 'base/skill' ? `/d/${domainId}/base/skill/data` : `/d/${domainId}/base/data`;
    const apiQs: Record<string, string> = {};
    if (docId && basePath === 'base') apiQs.docId = docId;
    const curBranch = (window as any).UiContext?.currentBranch;
    if (curBranch) apiQs.branch = curBranch;
    try {
      const newData: any = await request.get(apiPath, apiQs);
      if (newData?.nodes != null || newData?.edges != null) {
        setBase(prev => ({ ...prev, ...newData, nodes: newData.nodes ?? prev.nodes, edges: newData.edges ?? prev.edges }));
      }
      if (newData?.nodeCardsMap != null) setNodeCardsMap(newData.nodeCardsMap);
    } catch (e) {
      console.error('[BaseOutline] refetchOutlineData failed:', e);
    }
  }, [basePath, docId]);

 
  const outlineWsRef = useRef<{ close: () => void } | null>(null);
  useEffect(() => {
    const socketUrl = (window as any).UiContext?.socketUrl;
    const wsPrefix = (window as any).UiContext?.ws_prefix || '';
    const domainId = (window as any).UiContext?.domainId || 'system';
    if (!socketUrl) return;

    let closed = false;
    const apiPath = basePath === 'base/skill' ? `/d/${domainId}/base/skill/data` : `/d/${domainId}/base/data`;
    const wsApiQs: Record<string, string> = {};
    if (docId && basePath === 'base') wsApiQs.docId = docId;
    const wsBranch = (window as any).UiContext?.currentBranch;
    if (wsBranch) wsApiQs.branch = wsBranch;

    const connect = async () => {
      try {
        const { default: WebSocket } = await import('../components/socket');
        const wsUrl = wsPrefix + socketUrl;
        const sock = new WebSocket(wsUrl, false, true);
        outlineWsRef.current = sock;

        sock.onmessage = (_: any, data: string) => {
          if (closed) return;
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'init' || msg.type === 'update') {
              if (msg.type === 'update' && msg.sourceBranch && wsBranch && msg.sourceBranch !== wsBranch) return;
              request.get(apiPath, wsApiQs).then((newData: any) => {
                if (!closed && newData && (newData.nodes || newData.edges)) {
                  const nextBase: BaseDoc = { ...baseRef.current, ...newData, nodes: newData.nodes ?? baseRef.current.nodes, edges: newData.edges ?? baseRef.current.edges };
                  setBase(nextBase);
                  const nextMap = newData.nodeCardsMap != null ? newData.nodeCardsMap : {};
                  setNodeCardsMap(nextMap);
                }
              }).catch(() => {});
            }
          } catch (e) {
            // ignore parse error
          }
        };

        sock.onclose = () => {
          outlineWsRef.current = null;
        };
      } catch (e) {
        console.warn('[BaseOutline] WebSocket connect failed:', e);
      }
    };

    connect();
    return () => {
      closed = true;
      if (outlineWsRef.current) {
        outlineWsRef.current.close();
        outlineWsRef.current = null;
      }
    };
  }, [basePath, docId]);

  const getTheme = useCallback((): 'light' | 'dark' => {
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
  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) setTheme(newTheme);
    };
    checkTheme();
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);
  const themeStyles = useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bgPrimary: isDark ? '#121212' : '#fff',
      bgSecondary: isDark ? '#323334' : '#f6f8fa',
      bgHover: isDark ? '#424242' : '#f3f4f6',
      bgSelected: isDark ? '#1e3a5f' : '#e3f2fd',
      bgButton: isDark ? '#323334' : '#fff',
      bgButtonActive: isDark ? '#0366d6' : '#1976d6',
      textPrimary: isDark ? '#eee' : '#24292e',
      textSecondary: isDark ? '#bdbdbd' : '#586069',
      textTertiary: isDark ? '#999' : '#666',
      textOnPrimary: '#fff',
      borderPrimary: isDark ? '#424242' : '#e1e4e8',
      borderSecondary: isDark ? '#333' : '#eee',
      accent: isDark ? '#55b6e2' : '#1976d2',
    };
  }, [theme]);

 
  const expandSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
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
            expandedOutline: isExpanded,
          };
        });

       
       
        const domainIdForSave = (window as any).UiContext?.domainId || 'system';
        if (basePath !== 'base/skill' && docId) {
          const docIdNum = Number(docId);
          if (Number.isFinite(docIdNum) && docIdNum > 0) {
            await request.post(`/d/${domainIdForSave}/base/expand-state`, {
              docId: docIdNum,
              expandedNodeIds: Array.from(currentExpandedNodes),
            });
          }
        }
        
       
       
        setBase(prev => ({
          ...prev,
          nodes: updatedNodes,
        }));
        
        expandSaveTimerRef.current = null;
      } catch (error: any) {
        console.error('保存 outline 展开状态失败:', error);
        expandSaveTimerRef.current = null;
      }
    }, 1500);
  }, [docId, basePath]);

 
  const cardContentCacheRef = useRef<Record<string, string>>({});
 
  const imageCacheRef = useRef<Cache | null>(null);
 
  const cachedCardsRef = useRef<Set<string>>(new Set());
 
  const [cachingProgress, setCachingProgress] = useState<{ current: number; total: number; currentCard?: string } | null>(null);
 
  const [cacheStatus, setCacheStatus] = useState<{
    outdated: Array<{ cardId: string; title: string; cachedUpdateAt: string; currentUpdateAt: string }>;
    total: number;
  } | null>(null);
  const [isCheckingCache, setIsCheckingCache] = useState(false);
  const [isUpdatingCache, setIsUpdatingCache] = useState(false);
 
  const [explorerMode, setExplorerMode] = useState<'tree' | 'cache'>('tree');
  
 
  const [isMobile, setIsMobile] = useState(false);
  const [isExplorerOpen, setIsExplorerOpen] = useState(false);
  
 
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth <= 600;
      setIsMobile(mobile);
     
      if (mobile) {
        setIsExplorerOpen(false);
      }
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
 
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem } | null>(null);
 
  const longPressTriggeredRef = useRef<boolean>(false);
 
  // const [cachedCount, setCachedCount] = useState(0);
 
  // const [cachingProgress, setCachingProgress] = useState<{ current: number; total: number } | null>(null);
 
  // const [imageCachingProgress, setImageCachingProgress] = useState<{ current: number; total: number } | null>(null);
 
  // const [isCachingPaused, setIsCachingPaused] = useState(false);
 
  // const [showCachePanel, setShowCachePanel] = useState(false);
 
  // const cachingTaskRef = useRef<{ cancelled: boolean }>({ cancelled: false });
 
  const wsRef = useRef<any>(null);
 
  const wsRequestMapRef = useRef<Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>>(new Map());

 
  useEffect(() => {
    try {
      const keys = Object.keys(localStorage);
      const cachePrefix = 'base-outline-card-';
      let loadedCount = 0;
      let invalidatedCount = 0;
      
     
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const allCards: Card[] = [];
      Object.values(nodeCardsMap).forEach((cards: Card[]) => {
        if (Array.isArray(cards)) {
          allCards.push(...cards);
        }
      });
      const cardMap = new Map<string, Card>();
      allCards.forEach(card => {
        cardMap.set(String(card.docId), card);
      });
      
      keys.forEach(key => {
        if (key.startsWith(cachePrefix)) {
          const cardId = key.replace(cachePrefix, '');
          const cachedDataStr = localStorage.getItem(key);
          if (cachedDataStr) {
            try {
             
              const cachedData = JSON.parse(cachedDataStr);
              if (cachedData.html && cachedData.updateAt) {
               
                const currentCard = cardMap.get(cardId);
                if (currentCard && currentCard.updateAt && currentCard.updateAt !== cachedData.updateAt) {
                 
                  localStorage.removeItem(key);
                  invalidatedCount++;
                  return;
                }
                cardContentCacheRef.current[cardId] = cachedData.html;
                cachedCardsRef.current.add(cardId);
                loadedCount++;
              } else {
               
                cardContentCacheRef.current[cardId] = cachedData.html || cachedDataStr;
                cachedCardsRef.current.add(cardId);
                loadedCount++;
              }
            } catch (e) {
             
              cardContentCacheRef.current[cardId] = cachedDataStr;
              cachedCardsRef.current.add(cardId);
              loadedCount++;
            }
          }
        }
      });
      
      if (loadedCount > 0) {
        console.log(`[Base Outline] 从 localStorage 加载了 ${loadedCount} 个 card 缓存`);
      }
      if (invalidatedCount > 0) {
        console.log(`[Base Outline] 清除了 ${invalidatedCount} 个过期缓存`);
      }
    } catch (error) {
      console.error('Failed to load cache from localStorage:', error);
    }
    
   
    if ('caches' in window && !imageCacheRef.current) {
      caches.open('base-outline-images-v1').then(cache => {
        imageCacheRef.current = cache;
      }).catch(error => {
        console.error('Failed to init image cache:', error);
      });
    }
  }, []);

 
  useEffect(() => {
    const bg = theme === 'dark' ? '#121212' : '#fff';
    document.body.style.backgroundColor = bg;
    const panel = document.getElementById('panel');
    if (panel) {
      (panel as HTMLElement).style.backgroundColor = bg;
    }
    return () => {
      document.body.style.backgroundColor = '';
      if (panel) {
        (panel as HTMLElement).style.backgroundColor = '';
      }
    };
  }, [theme]);

 
  const checkCacheStatus = useCallback(async () => {
   
    if (isCheckingCache) {
      return;
    }
    
    setIsCheckingCache(true);
    try {
     
      await new Promise(resolve => {
        if (window.requestIdleCallback) {
          window.requestIdleCallback(() => resolve(undefined), { timeout: 1000 });
        } else {
          setTimeout(resolve, 0);
        }
      });

      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const allCards: Card[] = [];
      Object.values(nodeCardsMap).forEach((cards: Card[]) => {
        if (Array.isArray(cards)) {
          allCards.push(...cards);
        }
      });
      
      const outdated: Array<{ cardId: string; title: string; cachedUpdateAt: string; currentUpdateAt: string }> = [];
      const cachedCardIds = new Set<string>();
      
     
      const BATCH_SIZE = 50;
      for (let i = 0; i < allCards.length; i += BATCH_SIZE) {
        const batch = allCards.slice(i, i + BATCH_SIZE);
        
        for (const card of batch) {
          const cardIdStr = String(card.docId);
          try {
            const cacheKey = `base-outline-card-${cardIdStr}`;
            const cachedDataStr = localStorage.getItem(cacheKey);
            if (cachedDataStr) {
             
              cachedCardIds.add(cardIdStr);
             
              if (!cachedCardsRef.current.has(cardIdStr)) {
                cachedCardsRef.current.add(cardIdStr);
              }
              
              try {
                const cachedData = JSON.parse(cachedDataStr);
               
                if (cachedData.html) {
                 
                  if (cachedData.updateAt && card.updateAt && cachedData.updateAt !== card.updateAt) {
                    outdated.push({
                      cardId: cardIdStr,
                      title: card.title || '未命名卡片',
                      cachedUpdateAt: cachedData.updateAt,
                      currentUpdateAt: card.updateAt,
                    });
                  }
                 
                } else {
                 
                  outdated.push({
                    cardId: cardIdStr,
                    title: card.title || '未命名卡片',
                    cachedUpdateAt: '未知',
                    currentUpdateAt: card.updateAt || '未知',
                  });
                }
              } catch (e) {
               
                outdated.push({
                  cardId: cardIdStr,
                  title: card.title || '未命名卡片',
                  cachedUpdateAt: '未知',
                  currentUpdateAt: card.updateAt || '未知',
                });
              }
            }
          } catch (error) {
            console.error(`Failed to check cache for card ${cardIdStr}:`, error);
          }
        }
        
       
        if (i + BATCH_SIZE < allCards.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      
     
     
      try {
        const allKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('base-outline-card-')) {
            allKeys.push(key);
          }
        }
        
       
        const CLEANUP_BATCH_SIZE = 100;
        for (let i = 0; i < allKeys.length; i += CLEANUP_BATCH_SIZE) {
          const batch = allKeys.slice(i, i + CLEANUP_BATCH_SIZE);
          
          for (const key of batch) {
            const cardIdStr = key.replace('base-outline-card-', '');
            const card = allCards.find(c => String(c.docId) === cardIdStr);
            if (!card) {
             
              cachedCardsRef.current.delete(cardIdStr);
              delete cardContentCacheRef.current[cardIdStr];
              try {
                localStorage.removeItem(key);
              } catch (error) {
                console.error(`Failed to remove cache for ${cardIdStr}:`, error);
              }
            }
          }
          
         
          if (i + CLEANUP_BATCH_SIZE < allKeys.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      } catch (error) {
        console.error('Failed to clean up old cache entries:', error);
      }
      
     
      const cachedCardIdsArray = Array.from(cachedCardsRef.current);
      const SYNC_BATCH_SIZE = 100;
      for (let i = 0; i < cachedCardIdsArray.length; i += SYNC_BATCH_SIZE) {
        const batch = cachedCardIdsArray.slice(i, i + SYNC_BATCH_SIZE);
        for (const cardIdStr of batch) {
          const cacheKey = `base-outline-card-${cardIdStr}`;
          if (!localStorage.getItem(cacheKey)) {
            cachedCardsRef.current.delete(cardIdStr);
            delete cardContentCacheRef.current[cardIdStr];
          }
        }
        if (i + SYNC_BATCH_SIZE < cachedCardIdsArray.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      
      setCacheStatus({
        outdated,
        total: cachedCardIds.size,
      });
    } catch (error) {
      console.error('Failed to check cache status:', error);
    } finally {
      setIsCheckingCache(false);
    }
  }, [isCheckingCache]);

 
  const initializedBaseRef = useRef<number | null>(null);
  
 
  useEffect(() => {
    const currentbid = base?.bid;
    
   
    if (currentbid && currentbid !== initializedBaseRef.current) {
     
      const expanded = new Set<string>();
      base.nodes.forEach(node => {
        if (node.expandedOutline !== false) {
          expanded.add(node.id);
        }
      });
      setExpandedNodes(expanded);
      expandedNodesRef.current = expanded;
      initializedBaseRef.current = currentbid;
    }
    
   
    const timer = setTimeout(() => {
      if (cachedCardsRef.current.size > 0) {
        checkCacheStatus();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [base?.bid, checkCacheStatus]);

 
  const checkNodeCachedRef = useRef<((nodeId: string) => boolean) | null>(null);
  const checkNodeCached = useCallback((nodeId: string): boolean => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || []).filter((card: Card) => {
      return !card.nodeId || card.nodeId === nodeId;
    });
    
   
    const allCardsCached = nodeCards.length === 0 || nodeCards.every((card: Card) => {
      const cardIdStr = String(card.docId);
      return cachedCardsRef.current.has(cardIdStr);
    });
    
    if (!allCardsCached) {
      return false;
    }
    
   
    const nodeData = base.nodes.find(n => n.id === nodeId);
    if (!nodeData) {
      return allCardsCached;
    }
    
   
    const childNodeIds = base.edges
      .filter(edge => edge.source === nodeId)
      .map(edge => edge.target);
    
    if (childNodeIds.length === 0) {
      return allCardsCached;
    }
    
   
    const checkFn = checkNodeCachedRef.current || checkNodeCached;
    const allChildNodesCached = childNodeIds.every(childNodeId => {
      return checkFn(childNodeId);
    });
    
    return allCardsCached && allChildNodesCached;
  }, [base]);
  
 
  useEffect(() => {
    checkNodeCachedRef.current = checkNodeCached;
  }, [checkNodeCached]);

 
  const expandedNodesArray = useMemo(() => Array.from(expandedNodes), [expandedNodes]);
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

   
    const hasParentSet = new Set(base.edges.map(e => e.target));
    base.nodes.forEach((node) => {
      if (!hasParentSet.has(node.id)) {
        rootNodes.push(node.id);
      }
    });

   
    const nodeCardsMapCurrent = nodeCardsMap;
    const expandedSet = new Set(expandedNodesArray);

   
    const buildTree = (nodeId: string, level: number, parentId?: string) => {
      const nodeData = nodeMap.get(nodeId);
      if (!nodeData) return;

      const { node, children } = nodeData;
      const isExpanded = expandedSet.has(nodeId);

     
      const nodeFileItem: FileItem = {
        type: 'node',
        id: nodeId,
        name: node.text || '未命名节点',
        nodeId: nodeId,
        parentId,
        level,
      };
      items.push(nodeFileItem);

     
      if (isExpanded) {
       
        const nodeCards = (nodeCardsMapCurrent[nodeId] || [])
          .filter((card: Card) => {
            return !card.nodeId || card.nodeId === nodeId;
          })
          .sort((a: Card, b: Card) => (a.order || 0) - (b.order || 0));
        
       
        const childNodes = children
          .map(childId => {
            const childNodeData = nodeMap.get(childId);
            if (!childNodeData) return null;
            const childNode = childNodeData.node;
            return { id: childId, node: childNode, order: childNode.order || 0 };
          })
          .filter(Boolean)
          .sort((a, b) => (a!.order || 0) - (b!.order || 0)) as Array<{ id: string; node: BaseNode; order: number }>;

       
        const allChildren: Array<{ type: 'node' | 'card'; id: string; order: number; data: any }> = [
          ...childNodes.map(n => ({ type: 'node' as const, id: n.id, order: n.order, data: n.node })),
          ...nodeCards.map(c => ({ type: 'card' as const, id: c.docId, order: c.order || 0, data: c })),
        ];
        
       
        allChildren.sort((a, b) => (a.order || 0) - (b.order || 0));
        
       
        allChildren.forEach(item => {
          if (item.type === 'card') {
            const card = item.data as Card;
            const cardFileItem: FileItem = {
              type: 'card',
              id: `card-${card.docId}`,
              name: card.title || '未命名卡片',
              nodeId: card.nodeId || nodeId,
              cardId: card.docId,
              parentId: card.nodeId || nodeId,
              level: level + 1,
            };
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

    return items;
  }, [base.nodes, base.edges, expandedNodesArray, nodeCardsMap]);

 
  const toggleNodeExpanded = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      
     
      setBase(prev => {
        const updated = {
          ...prev,
          nodes: prev.nodes.map(n =>
            n.id === nodeId
              ? { ...n, expandedOutline: newSet.has(nodeId) }
              : n
          ),
        };
       
        baseRef.current = updated;
        return updated;
      });
      
     
      expandedNodesRef.current = newSet;
      
     
      triggerExpandAutoSave();
      
      return newSet;
    });
  }, [triggerExpandAutoSave]);

 
  const getNodeSubgraph = useCallback((nodeId: string): { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] } => {
    const nodeMap = new Map<string, BaseNode>();
    const edgeMap = new Map<string, BaseEdge>();
    const visitedNodes = new Set<string>();

   
    const collectNodes = (id: string) => {
      if (visitedNodes.has(id)) return;
      visitedNodes.add(id);

      const node = base.nodes.find(n => n.id === id);
    if (!node) return;
    
      nodeMap.set(id, node);

     
      const childEdges = base.edges.filter(e => e.source === id);
      childEdges.forEach(edge => {
        edgeMap.set(edge.id, edge);
       
        collectNodes(edge.target);
    });
    };

   
    collectNodes(nodeId);

   
    const reactFlowNodes: ReactFlowNode[] = Array.from(nodeMap.values()).map(node => ({
        id: node.id,
      type: 'default',
      position: { x: node.x || 0, y: node.y || 0 },
        data: {
        label: node.text || '未命名节点',
          originalNode: node,
      },
    }));

   
    const reactFlowEdges: ReactFlowEdge[] = Array.from(edgeMap.values())
      .filter(edge => nodeMap.has(edge.source) && nodeMap.has(edge.target))
      .map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
        type: 'default',
        data: {
          originalEdge: edge,
        },
      }));

    return { nodes: reactFlowNodes, edges: reactFlowEdges };
  }, [base]);

 
  const handleNodeToggleExpand = useCallback((nodeId: string) => {
   
    setBase(prev => ({
      ...prev,
      nodes: prev.nodes.map(node =>
        node.id === nodeId
          ? { ...node, expanded: node.expanded === false ? true : false }
          : node
      ),
    }));
  }, []);

 
  const handleNodeClick = useCallback((nodeId: string) => {
    void nodeId;
  }, []);

  const outlineUiDomainId = useCallback((): string => {
    const rawDomainId = (window as any).UiContext?.domainId;
    return typeof rawDomainId === 'object'
      ? (rawDomainId?._id ? String(rawDomainId._id) : 'system')
      : (rawDomainId ? String(rawDomainId) : 'system');
  }, []);

  const startEditorSessionFromOutline = useCallback(async (nodeId: string) => {
    if (!nodeId || outlineStartBusy) return;
    const domainId = outlineUiDomainId();
    const baseDocNum = Number((base as any).docId ?? docId);
    if (!Number.isFinite(baseDocNum) || baseDocNum <= 0) {
      Notification.error(i18n('Outline editor start invalid base'));
      return;
    }
    const branch = base.currentBranch || 'main';
    setOutlineStartBusy(true);
    try {
      const res: any = await request.post(`/d/${domainId}/session/develop/start`, {
        baseDocId: baseDocNum,
        branch,
        fromOutline: true,
        nodeId,
      });
      const sessionId = res?.sessionId ?? res?.body?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        Notification.error(i18n('Outline editor start failed'));
        return;
      }
      const sp = new URLSearchParams({
        session: sessionId.trim(),
        nodeId,
      });
      const bid = (base as any)?.bid;
      const docSeg = bid && String(bid).trim() ? String(bid).trim() : String(baseDocNum);
      const editorUrl = `/d/${domainId}/base/${encodeURIComponent(docSeg)}/branch/${encodeURIComponent(branch)}/editor?${sp.toString()}`;
      const opened = window.open(editorUrl, '_blank');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Outline editor start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setOutlineStartBusy(false);
    }
  }, [base.currentBranch, base, docId, outlineStartBusy, outlineUiDomainId]);

  const startSingleCardLearnFromOutline = useCallback(async (cardIdRaw: string | undefined) => {
    const cardId = String(cardIdRaw || '').trim();
    if (!cardId || learnOutlineBusy) return;
    if (!/^[a-f0-9]{24}$/i.test(cardId)) {
      Notification.error(i18n('Outline learn invalid card'));
      return;
    }
    const domainId = outlineUiDomainId();
    setLearnOutlineBusy(true);
    try {
      const res: any = await request.post(`/d/${domainId}/learn/lesson/start`, {
        mode: 'card',
        cardId,
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || `/d/${domainId}/learn/lesson?cardId=${encodeURIComponent(cardId)}`;
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Outline learn start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setLearnOutlineBusy(false);
    }
  }, [learnOutlineBusy, outlineUiDomainId]);

  const startSingleNodeLearnFromOutline = useCallback(async (nodeId: string | undefined) => {
    const nid = String(nodeId || '').trim();
    if (!nid || learnOutlineBusy) return;
    const baseDocNum = Number((base as any).docId ?? docId);
    if (!Number.isFinite(baseDocNum) || baseDocNum <= 0) {
      Notification.error(i18n('Outline editor start invalid base'));
      return;
    }
    const branch = base.currentBranch || 'main';
    const domainId = outlineUiDomainId();
    setLearnOutlineBusy(true);
    try {
      const res: any = await request.post(`/d/${domainId}/learn/lesson/start`, {
        mode: 'node',
        nodeId: nid,
        baseDocId: baseDocNum,
        branch,
      });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      const url = redir || `/d/${domainId}/learn/lesson`;
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        opened.opener = null;
      } else {
        Notification.error(i18n('Outline editor popup blocked'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Outline learn start failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setLearnOutlineBusy(false);
    }
  }, [learnOutlineBusy, outlineUiDomainId, base, docId]);

 
  const initImageCache = useCallback(async () => {
    if ('caches' in window && !imageCacheRef.current) {
      try {
        imageCacheRef.current = await caches.open('base-outline-images-v1');
      } catch (error) {
        console.error('Failed to open image cache:', error);
      }
    }
  }, []);

 
  const getCachedImage = useCallback(async (url: string): Promise<string> => {
    if (!imageCacheRef.current) {
      await initImageCache();
    }
    
    if (!imageCacheRef.current) {
      return url;
    }
    
    try {
      const cachedResponse = await imageCacheRef.current.match(url);
      if (cachedResponse) {
        const blob = await cachedResponse.blob();
        return URL.createObjectURL(blob);
      }
      
      const response = await fetch(url);
      if (response.ok) {
        const responseClone = response.clone();
        await imageCacheRef.current.put(url, responseClone);
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      }
    } catch (error) {
      console.error(`Failed to cache image ${url}:`, error);
    }
    
    return url;
  }, [initImageCache]);

 
  const preloadAndCacheImages = useCallback(async (html: string): Promise<void> => {
    if (!html) return;
    
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const imageUrls: string[] = [];
    let match;
    
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
      if (url && !url.startsWith('blob:') && !url.startsWith('data:')) {
        imageUrls.push(url);
      }
    }
    
    if (imageUrls.length === 0) return;
    
    await initImageCache();
    
   
    const imagePromises = imageUrls.map(async (originalUrl) => {
      try {
        await getCachedImage(originalUrl);
      } catch (error) {
        console.error(`Failed to cache image ${originalUrl}:`, error);
      }
    });
    
    await Promise.all(imagePromises);
  }, [initImageCache, getCachedImage]);

 
  const replaceImagesWithCache = useCallback(async (html: string): Promise<string> => {
    if (!html) return html;
    
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const imageUrls: string[] = [];
    let match;
    
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
     
      if (url && !url.startsWith('blob:') && !url.startsWith('data:')) {
        imageUrls.push(url);
      }
    }
    
    if (imageUrls.length === 0) return html;
    
    await initImageCache();
    
    const urlMap = new Map<string, string>();
    const imagePromises = imageUrls.map(async (originalUrl) => {
      try {
        const cachedUrl = await getCachedImage(originalUrl);
        if (cachedUrl !== originalUrl) {
          urlMap.set(originalUrl, cachedUrl);
        }
      } catch (error) {
        console.error(`Failed to get cached image ${originalUrl}:`, error);
      }
    });
    
    await Promise.all(imagePromises);
    
    let updatedHtml = html;
    urlMap.forEach((cachedUrl, originalUrl) => {
      const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      updatedHtml = updatedHtml.replace(new RegExp(escapedUrl, 'g'), cachedUrl);
    });
    
    return updatedHtml;
  }, [initImageCache, getCachedImage]);

 
  const preloadCardContent = useCallback(async (card: Card) => {
    const cardIdStr = String(card.docId);
    
    if (!card.content) {
      const emptyHtml = '<p style="color: #888;">暂无内容</p>';
      cardContentCacheRef.current[cardIdStr] = emptyHtml;
      cachedCardsRef.current.add(cardIdStr);
      try {
        const cacheKey = `base-outline-card-${cardIdStr}`;
        const cacheData = {
          html: emptyHtml,
          updateAt: card.updateAt || '',
        };
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (error) {
        console.error('Failed to save to localStorage:', error);
      }
      return;
    }
    
    try {
      let html: string;
      if (wsRef.current) {
        const requestId = `md_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        html = await new Promise<string>((resolve, reject) => {
          wsRequestMapRef.current.set(requestId, { resolve, reject });
          wsRef.current.send(JSON.stringify({
            type: 'request_markdown',
            requestId,
            text: card.content || '',
            inline: false,
          }));
          setTimeout(() => {
            if (wsRequestMapRef.current.has(requestId)) {
              wsRequestMapRef.current.delete(requestId);
              reject(new Error('Markdown request timeout'));
            }
          }, 30000);
        });
      } else {
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
        html = await response.text();
      }
      
     
      await preloadAndCacheImages(html);
      
     
      cardContentCacheRef.current[cardIdStr] = html;
      cachedCardsRef.current.add(cardIdStr);
      
      try {
        const cacheKey = `base-outline-card-${cardIdStr}`;
        const cacheData = {
          html: html,
          updateAt: card.updateAt || '',
        };
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (error) {
        console.error('Failed to save to localStorage:', error);
      }
    } catch (error) {
      console.error(`Failed to preload card ${card.docId}:`, error);
      const errorHtml = '<p style="color: #f44336;">加载内容失败</p>';
      cardContentCacheRef.current[cardIdStr] = errorHtml;
      cachedCardsRef.current.add(cardIdStr);
    }
  }, [preloadAndCacheImages]);

 
  const clearCardCache = useCallback((cardId: string) => {
    const cardIdStr = String(cardId);
   
    delete cardContentCacheRef.current[cardIdStr];
    cachedCardsRef.current.delete(cardIdStr);
   
    try {
      const cacheKey = `base-outline-card-${cardIdStr}`;
      localStorage.removeItem(cacheKey);
    } catch (error) {
      console.error(`Failed to remove cache for ${cardIdStr}:`, error);
    }
   
    if (selectedCard && String(selectedCard.docId) === cardIdStr) {
      const currentCard = selectedCard;
      setSelectedCard(null);
      setTimeout(() => {
        setSelectedCard(currentCard);
      }, 100);
    }
   
    if (cacheStatus) {
      setCacheStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          outdated: prev.outdated.filter(item => item.cardId !== cardIdStr),
        };
      });
    }
  }, [selectedCard, cacheStatus]);

 
  const clearNodeCache = useCallback((nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = nodeCardsMap[nodeId] || [];
    
   
    nodeCards.forEach((card: Card) => {
      const cardIdStr = String(card.docId);
      delete cardContentCacheRef.current[cardIdStr];
      cachedCardsRef.current.delete(cardIdStr);
      try {
        const cacheKey = `base-outline-card-${cardIdStr}`;
        localStorage.removeItem(cacheKey);
      } catch (error) {
        console.error(`Failed to remove cache for ${cardIdStr}:`, error);
      }
    });
    
   
    const childNodeIds = base.edges
      .filter(edge => edge.source === nodeId)
      .map(edge => edge.target);
    
    childNodeIds.forEach(childNodeId => {
      clearNodeCache(childNodeId);
    });
    
   
    if (selectedCard && selectedCard.nodeId === nodeId) {
      const currentCard = selectedCard;
      setSelectedCard(null);
      setTimeout(() => {
        setSelectedCard(currentCard);
      }, 100);
    }
    
   
    if (cacheStatus) {
      checkCacheStatus();
    }
  }, [base.edges, selectedCard, cacheStatus, checkCacheStatus]);

 
  const updateOutdatedCache = useCallback(async () => {
    if (!cacheStatus || cacheStatus.outdated.length === 0) return;
    
    setIsUpdatingCache(true);
    setCachingProgress({
      current: 0,
      total: cacheStatus.outdated.length,
    });
    
    try {
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      const allCards: Card[] = [];
      Object.values(nodeCardsMap).forEach((cards: Card[]) => {
        if (Array.isArray(cards)) {
          allCards.push(...cards);
        }
      });
      
     
      const remainingOutdated = [...cacheStatus.outdated];
      for (let i = 0; i < remainingOutdated.length; i++) {
        const item = remainingOutdated[i];
        const card = allCards.find(c => String(c.docId) === item.cardId);
        if (card) {
         
          setCachingProgress(prev => {
            if (!prev) return null;
            return {
              ...prev,
              current: i,
              currentCard: card.title || '未命名卡片',
            };
          });
          
         
          delete cardContentCacheRef.current[item.cardId];
          cachedCardsRef.current.delete(item.cardId);
          try {
            const cacheKey = `base-outline-card-${item.cardId}`;
            localStorage.removeItem(cacheKey);
          } catch (error) {
            console.error(`Failed to remove cache for ${item.cardId}:`, error);
          }
          
         
          await preloadCardContent(card);
          
         
          await new Promise(resolve => setTimeout(resolve, 50));
          
         
          let cacheVerified = false;
          try {
            const cacheKey = `base-outline-card-${item.cardId}`;
            const cachedDataStr = localStorage.getItem(cacheKey);
            if (cachedDataStr) {
              try {
                const cachedData = JSON.parse(cachedDataStr);
               
                if (cachedData.html) {
                 
                  if (cachedData.updateAt && card.updateAt && cachedData.updateAt === card.updateAt) {
                    cacheVerified = true;
                  } else {
                   
                    console.warn(`Cache updateAt mismatch for ${item.cardId}: cached=${cachedData.updateAt}, card=${card.updateAt}, but cache was just updated`);
                    cacheVerified = true;
                  }
                } else {
                 
                  cacheVerified = false;
                }
              } catch (e) {
               
                cacheVerified = false;
              }
            } else {
             
              cacheVerified = false;
            }
          } catch (error) {
            console.error(`Failed to verify cache for ${item.cardId}:`, error);
            cacheVerified = false;
          }
          
         
          if (cacheVerified) {
            setCacheStatus(prev => {
              if (!prev) return null;
              const updatedOutdated = prev.outdated.filter(outdatedItem => outdatedItem.cardId !== item.cardId);
              return {
                outdated: updatedOutdated,
                total: prev.total,
              };
            });
          } else {
            console.warn(`Cache verification failed for ${item.cardId}, keeping it in outdated list`);
          }
        }
        
       
        setCachingProgress(prev => {
          if (!prev) return null;
          return {
            ...prev,
            current: i + 1,
          };
        });
      }
      
     
     
      setCacheStatus(prev => {
        if (!prev || prev.outdated.length === 0) {
          return null;
        }
        return prev;
      });
      setCachingProgress(null);
    } catch (error) {
      console.error('Failed to update outdated cache:', error);
    } finally {
      setIsUpdatingCache(false);
      setCachingProgress(null);
    }
  }, [cacheStatus, preloadCardContent]);

 
  const cacheNodeCards = useCallback(async (nodeId: string) => {
    const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const nodeCards = (nodeCardsMap[nodeId] || []).sort((a: Card, b: Card) => {
      const orderA = (a.order as number) || 0;
      const orderB = (b.order as number) || 0;
      return orderA - orderB;
    });
    
    if (nodeCards.length === 0) return;
    
    const cardsToCache = nodeCards.filter((card: Card) => {
      const cardIdStr = String(card.docId);
      return !cachedCardsRef.current.has(cardIdStr);
    });
    
    if (cardsToCache.length === 0) {
      setCachingProgress(null);
      return;
    }
    
    console.log(`[Base Outline] 开始缓存 node ${nodeId} 下的 ${cardsToCache.length} 个 card`);
    
   
    setCachingProgress({ current: 0, total: cardsToCache.length });
    
    const batchSize = 5;
    for (let i = 0; i < cardsToCache.length; i += batchSize) {
      const batch = cardsToCache.slice(i, i + batchSize);
      await Promise.all(batch.map(async (card: Card) => {
        await preloadCardContent(card);
        setCachingProgress(prev => {
          if (!prev) return null;
          const newCurrent = prev.current + 1;
          return {
            ...prev,
            current: newCurrent,
            currentCard: card.title || '未命名卡片',
          };
        });
      }));
    }
    
    console.log(`[Base Outline] 完成缓存 node ${nodeId} 下的 card`);
   
    setTimeout(() => {
      setCachingProgress(null);
    }, 500);
  }, [preloadCardContent]);

 
  /*
  const preloadAllCards = useCallback(async () => {
   
  }, []);
  */

 
  /*
  const startCaching = useCallback(() => {
   
  }, []);
  */

 
  /*
  const pauseCaching = useCallback(() => {
   
  }, []);
  */

 
  /*
  const clearCache = useCallback(async () => {
   
  }, []);
  */

 
  /* const getCacheSize = useCallback(() => {
    let size = 0;
    Object.values(cardContentCacheRef.current).forEach((html: string) => {
      size += new Blob([html]).size;
    });
    return size;
  }, []);

 
  /* const formatCacheSize = useCallback((bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }, []); */

 
  const clearAllHighlights = useCallback(() => {
    const fileTreeContainer = document.querySelector('[data-file-tree-container]');
    if (fileTreeContainer) {
      const allItems = fileTreeContainer.querySelectorAll('[data-file-item]');
      allItems.forEach((item) => {
        const element = item as HTMLElement;
       
        element.style.backgroundColor = '';
        element.style.borderLeft = '';
        element.style.color = '';
        element.style.fontWeight = '';
      });
    }
  }, []);

 
  const handleSelectCard = useCallback((card: Card, skipUrlUpdate = false) => {
   
    clearAllHighlights();
    
    setSelectedCard(card);
   
    const fileId = `card-${card.docId}`;
    selectedFileIdRef.current = fileId;
    setSelectedFileId(fileId);
    
   
    if (!skipUrlUpdate) {
      const urlParams = new URLSearchParams(window.location.search);
      urlParams.set('cardId', String(card.docId));
      urlParams.delete('nodeId');
      const newUrl = window.location.pathname + '?' + urlParams.toString();
      window.history.pushState({ cardId: card.docId }, '', newUrl);
    }
  }, [clearAllHighlights]);

 
  useEffect(() => {
   
    if (isManualSelectionRef.current) {
      isManualSelectionRef.current = false;
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('cardId');
    const nodeId = urlParams.get('nodeId');
    
    if (cardId) {
     
      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
      let foundCard: Card | null = null;
      let cardNodeId: string | null = null;
      
     
      for (const [nodeIdKey, cards] of Object.entries(nodeCardsMap)) {
        if (Array.isArray(cards)) {
          const card = cards.find((c: Card) => String(c.docId) === String(cardId));
          if (card) {
            foundCard = card;
            cardNodeId = nodeIdKey;
            break;
          }
        }
      }
      
      if (foundCard && cardNodeId) {
       
        if (!expandedNodes.has(cardNodeId)) {
          setExpandedNodes(prev => {
            const newSet = new Set(prev);
            newSet.add(cardNodeId!);
            return newSet;
          });
         
          setTimeout(() => {
            if (!selectedCard || String(selectedCard.docId) !== String(cardId)) {
              clearAllHighlights();
              const fileId = `card-${foundCard!.docId}`;
              selectedFileIdRef.current = fileId;
              setSelectedFileId(fileId);
              handleSelectCard(foundCard!, true);
              setSelectedNodeId(null);
            }
          }, 100);
          return;
        }
        
       
        if (!selectedCard || String(selectedCard.docId) !== String(cardId)) {
         
          clearAllHighlights();
          
         
          const fileId = `card-${foundCard.docId}`;
          selectedFileIdRef.current = fileId;
          setSelectedFileId(fileId);
          handleSelectCard(foundCard, true);
          setSelectedNodeId(null);
        }
      }
    } else if (nodeId) {
     
     
      if (base.nodes.length > 0) {
        const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
        if (nodeFile && (!selectedNodeId || selectedNodeId !== nodeId)) {
         
          clearAllHighlights();
          
         
          selectedFileIdRef.current = nodeId;
          setSelectedFileId(nodeId);
          setSelectedNodeId(nodeId);
          setSelectedCard(null);
        }
      }
    } else if (!cardId && !nodeId) {
     
      selectedFileIdRef.current = null;
      setSelectedFileId(null);
      setSelectedCard(null);
      setSelectedNodeId(null);
    }
  }, [fileTree, selectedCard, selectedNodeId, handleSelectCard, expandedNodes, base.nodes]);

 
  const scrollToSelectedItem = useCallback(() => {
    if (!selectedCard && !selectedNodeId) return;
    
   
    setTimeout(() => {
      const fileTreeContainer = document.querySelector('[data-file-tree-container]') as HTMLElement;
      if (!fileTreeContainer) return;
      
     
      let selectedElement: HTMLElement | null = null;
      if (selectedCard) {
       
        const cardId = String(selectedCard.docId);
        const items = Array.from(fileTreeContainer.querySelectorAll('[data-file-item]'));
        for (const item of items) {
          const fileCardId = (item as HTMLElement).getAttribute('data-file-card-id');
         
          if (fileCardId && fileCardId === cardId && !(item as HTMLElement).getAttribute('data-file-node-id')) {
            selectedElement = item as HTMLElement;
            break;
          }
        }
      } else if (selectedNodeId) {
       
        const items = Array.from(fileTreeContainer.querySelectorAll('[data-file-item]'));
        for (const item of items) {
          const fileNodeId = (item as HTMLElement).getAttribute('data-file-node-id');
         
          if (fileNodeId && fileNodeId === selectedNodeId && !(item as HTMLElement).getAttribute('data-file-card-id')) {
            selectedElement = item as HTMLElement;
            break;
          }
        }
      }
      
     
      if (selectedElement) {
        const containerRect = fileTreeContainer.getBoundingClientRect();
        const elementRect = selectedElement.getBoundingClientRect();
        
       
        const scrollTop = fileTreeContainer.scrollTop;
        const elementTop = elementRect.top - containerRect.top + scrollTop;
        const elementBottom = elementTop + elementRect.height;
        const containerHeight = fileTreeContainer.clientHeight;
        
       
        if (elementTop < scrollTop || elementBottom > scrollTop + containerHeight) {
          fileTreeContainer.scrollTo({
            top: elementTop - containerHeight / 2 + elementRect.height / 2,
            behavior: 'smooth',
          });
        }
      }
    }, 100);
  }, [selectedCard, selectedNodeId]);

 
  useEffect(() => {
    scrollToSelectedItem();
  }, [scrollToSelectedItem, fileTree]);

 
  useEffect(() => {
    if (isMobile && isExplorerOpen && (selectedCard || selectedNodeId)) {
     
      const timer = setTimeout(() => {
        scrollToSelectedItem();
      }, 350);
      
      return () => clearTimeout(timer);
    }
  }, [isMobile, isExplorerOpen, selectedCard, selectedNodeId, scrollToSelectedItem]);

 
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const urlParams = new URLSearchParams(window.location.search);
      const cardId = urlParams.get('cardId');
      const nodeId = urlParams.get('nodeId');
      
     
      isManualSelectionRef.current = false;
      
      if (cardId && fileTree.length > 0) {
        const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
        const cardFile = fileTree.find(f => f.type === 'card' && f.cardId === cardId);
        if (cardFile) {
          const nodeCards = nodeCardsMap[cardFile.nodeId || ''] || [];
          const card = nodeCards.find((c: Card) => c.docId === cardId);
          if (card && (!selectedCard || selectedCard.docId !== card.docId)) {
           
            clearAllHighlights();
            
           
            const fileId = `card-${card.docId}`;
            selectedFileIdRef.current = fileId;
            setSelectedFileId(fileId);
            handleSelectCard(card, true);
            setSelectedNodeId(null);
          }
        }
      } else if (nodeId && fileTree.length > 0) {
        const nodeFile = fileTree.find(f => f.type === 'node' && f.nodeId === nodeId);
        if (nodeFile && (!selectedNodeId || selectedNodeId !== nodeId)) {
         
          clearAllHighlights();
          
         
          selectedFileIdRef.current = nodeId;
          setSelectedFileId(nodeId);
          setSelectedNodeId(nodeId);
          setSelectedCard(null);
        }
      } else if (!cardId && !nodeId) {
       
        clearAllHighlights();
        
        selectedFileIdRef.current = null;
        setSelectedFileId(null);
        setSelectedCard(null);
        setSelectedNodeId(null);
      }
    };
    
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [fileTree, selectedCard, selectedNodeId, handleSelectCard]);

 
  const attachImagePreviewHandlers = useCallback((container: HTMLElement) => {
    const images = container.querySelectorAll('img');
    images.forEach((img) => {
     
      const newImg = img.cloneNode(true) as HTMLImageElement;
      img.parentNode?.replaceChild(newImg, img);
      
     
      newImg.style.cursor = 'pointer';
      newImg.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const imageUrl = newImg.src || newImg.getAttribute('src') || '';
        if (!imageUrl) return;
        
        try {
         
          const previewImage = (window as any).Ejunz?.components?.preview?.previewImage;
          if (previewImage) {
            await previewImage(imageUrl);
          } else {
           
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
              $action: null,
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
  }, []);

 
  const renderingCardRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedCard) {
      renderingCardRef.current = null;
      return;
    }
    
    const contentDiv = document.getElementById('card-content-outline');
    if (!contentDiv) return;
    
    const cardIdStr = String(selectedCard.docId);
    
   
    if (renderingCardRef.current === cardIdStr) {
      return;
    }
    renderingCardRef.current = cardIdStr;
    
   
    if (cardContentCacheRef.current[cardIdStr]) {
      const cachedHtml = cardContentCacheRef.current[cardIdStr];
     
      replaceImagesWithCache(cachedHtml).then(htmlWithCachedImages => {
       
        if (selectedCard && String(selectedCard.docId) === cardIdStr) {
          contentDiv.innerHTML = htmlWithCachedImages;
          $(contentDiv).trigger('vjContentNew');
          attachImagePreviewHandlers(contentDiv);
        }
      }).catch(error => {
        console.error('Failed to replace images with cache:', error);
       
        contentDiv.innerHTML = cachedHtml;
        $(contentDiv).trigger('vjContentNew');
        attachImagePreviewHandlers(contentDiv);
      });
      
     
      const nodeId = selectedCard.nodeId || '';
      if (nodeId) {
       
        setTimeout(() => {
         
          if (selectedCard && String(selectedCard.docId) === cardIdStr) {
            cacheNodeCards(nodeId).catch(error => {
              console.error('Failed to cache node cards:', error);
            });
          }
        }, 500);
      }
      return;
    }
    
   
    try {
      const cacheKey = `base-outline-card-${cardIdStr}`;
      const cachedDataStr = localStorage.getItem(cacheKey);
      if (cachedDataStr) {
        try {
         
          const cachedData = JSON.parse(cachedDataStr);
          const cachedHtml = cachedData.html || cachedDataStr;
          cardContentCacheRef.current[cardIdStr] = cachedHtml;
          cachedCardsRef.current.add(cardIdStr);
         
          replaceImagesWithCache(cachedHtml).then(htmlWithCachedImages => {
           
            if (selectedCard && String(selectedCard.docId) === cardIdStr) {
              contentDiv.innerHTML = htmlWithCachedImages;
              $(contentDiv).trigger('vjContentNew');
              attachImagePreviewHandlers(contentDiv);
            }
          }).catch(error => {
            console.error('Failed to replace images with cache:', error);
           
            if (selectedCard && String(selectedCard.docId) === cardIdStr) {
              contentDiv.innerHTML = cachedHtml;
              $(contentDiv).trigger('vjContentNew');
              attachImagePreviewHandlers(contentDiv);
            }
          });
          
         
          const nodeId = selectedCard.nodeId || '';
          if (nodeId) {
            setTimeout(() => {
              if (selectedCard && String(selectedCard.docId) === cardIdStr) {
                cacheNodeCards(nodeId).catch(error => {
                  console.error('Failed to cache node cards:', error);
                });
              }
            }, 500);
          }
          return;
        } catch (e) {
         
          cardContentCacheRef.current[cardIdStr] = cachedDataStr;
          cachedCardsRef.current.add(cardIdStr);
         
          replaceImagesWithCache(cachedDataStr).then(htmlWithCachedImages => {
           
            if (selectedCard && String(selectedCard.docId) === cardIdStr) {
              contentDiv.innerHTML = htmlWithCachedImages;
              $(contentDiv).trigger('vjContentNew');
              attachImagePreviewHandlers(contentDiv);
            }
          }).catch(error => {
            console.error('Failed to replace images with cache:', error);
           
            if (selectedCard && String(selectedCard.docId) === cardIdStr) {
              contentDiv.innerHTML = cachedDataStr;
              $(contentDiv).trigger('vjContentNew');
              attachImagePreviewHandlers(contentDiv);
            }
          });
          
          const nodeId = selectedCard.nodeId || '';
          if (nodeId) {
            setTimeout(() => {
              if (selectedCard && String(selectedCard.docId) === cardIdStr) {
                cacheNodeCards(nodeId).catch(error => {
                  console.error('Failed to cache node cards:', error);
                });
              }
            }, 500);
          }
          return;
        }
      }
    } catch (error) {
      console.error('Failed to read from localStorage:', error);
    }
    
   
    if (selectedCard.content) {
      contentDiv.innerHTML = '<p style="color: #999; text-align: center;">加载中...</p>';
      
      const renderMarkdown = async () => {
        if (wsRef.current) {
          const requestId = `md_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          return new Promise<string>((resolve, reject) => {
            wsRequestMapRef.current.set(requestId, { resolve, reject });
            wsRef.current.send(JSON.stringify({
              type: 'request_markdown',
              requestId,
              text: selectedCard.content || '',
              inline: false,
            }));
            setTimeout(() => {
              if (wsRequestMapRef.current.has(requestId)) {
                wsRequestMapRef.current.delete(requestId);
                reject(new Error('Markdown request timeout'));
              }
            }, 30000);
          });
        } else {
          const response = await fetch('/markdown', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: selectedCard.content || '',
              inline: false,
            }),
          });
          if (!response.ok) {
            throw new Error('Failed to render markdown');
          }
          return response.text();
        }
      };
      
      renderMarkdown()
      .then(async html => {
       
        contentDiv.innerHTML = html;
        $(contentDiv).trigger('vjContentNew');
        attachImagePreviewHandlers(contentDiv);
        
       
        cardContentCacheRef.current[cardIdStr] = html;
        cachedCardsRef.current.add(cardIdStr);
        
       
        try {
          const cacheKey = `base-outline-card-${cardIdStr}`;
          const cacheData = {
            html: html,
            updateAt: selectedCard.updateAt || '',
          };
          localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (error) {
          console.error('Failed to save to localStorage:', error);
        }
        
       
        preloadAndCacheImages(html).then(async () => {
         
          replaceImagesWithCache(html).then(htmlWithCachedImages => {
           
            if (selectedCard && String(selectedCard.docId) === cardIdStr) {
              contentDiv.innerHTML = htmlWithCachedImages;
              $(contentDiv).trigger('vjContentNew');
              attachImagePreviewHandlers(contentDiv);
            }
          }).catch(error => {
            console.error('Failed to replace images with cache:', error);
          });
        }).catch(error => {
          console.error('Failed to cache images:', error);
        });
        
       
        const nodeId = selectedCard.nodeId || '';
        if (nodeId) {
          setTimeout(() => {
            if (selectedCard && String(selectedCard.docId) === cardIdStr) {
              cacheNodeCards(nodeId).catch(error => {
                console.error('Failed to cache node cards:', error);
              });
            }
          }, 500);
        }
      })
      .catch(error => {
        console.error('Failed to render markdown:', error);
        const errorHtml = '<p style="color: #f44336;">加载内容失败</p>';
        cardContentCacheRef.current[cardIdStr] = errorHtml;
        contentDiv.innerHTML = errorHtml;
      });
    } else {
      const emptyHtml = '<p style="color: #888;">暂无内容</p>';
      cardContentCacheRef.current[cardIdStr] = emptyHtml;
      cachedCardsRef.current.add(cardIdStr);
      contentDiv.innerHTML = emptyHtml;
    }
  }, [selectedCard, preloadAndCacheImages, replaceImagesWithCache, cacheNodeCards, preloadCardContent, attachImagePreviewHandlers]);


 
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const fromEdit = urlParams.get('fromEdit');
    const cardId = urlParams.get('cardId');
    
    if (fromEdit === 'true' && cardId && selectedCard && String(selectedCard.docId) === cardId) {
     
      const cardIdStr = String(selectedCard.docId);
      delete cardContentCacheRef.current[cardIdStr];
      cachedCardsRef.current.delete(cardIdStr);
      
     
      try {
        const cacheKey = `base-outline-card-${cardIdStr}`;
        localStorage.removeItem(cacheKey);
      } catch (error) {
        console.error('Failed to remove from localStorage:', error);
      }
      
     
      const domainId = (window as any).UiContext?.domainId || 'system';
      const dataApiPath = basePath === 'base/skill' ? `/d/${domainId}/base/skill/data` : `/d/${domainId}/base/data`;
      const dataQs2: Record<string, string> = {};
      if (docId && basePath === 'base') dataQs2.docId = docId;
      const dBranch2 = (window as any).UiContext?.currentBranch;
      if (dBranch2) dataQs2.branch = dBranch2;
      request.get(dataApiPath, dataQs2).then((responseData) => {
        if (responseData?.base) {
          setBase(responseData.base);
        } else {
          setBase(responseData);
        }
        if ((window as any).UiContext) {
          const updatedMap = responseData?.nodeCardsMap
            || responseData?.base?.nodeCardsMap
            || {};
          (window as any).UiContext.nodeCardsMap = updatedMap;
          
         
          const nodeCards = updatedMap[selectedCard.nodeId || ''] || [];
          const updatedCard = nodeCards.find((c: Card) => c.docId === selectedCard.docId);
          if (updatedCard) {
            setSelectedCard(updatedCard);
          }
        }
        
       
        urlParams.delete('fromEdit');
        const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, '', newUrl);
      }).catch((error) => {
        console.error('Failed to reload data:', error);
      });
    }
  }, [docId, selectedCard]);

 
 
  const globalWsKey = `base-ws-${docId}`;
  
  useEffect(() => {
   
    const cleanupOldConnection = () => {
      const oldWs = (window as any)[globalWsKey];
      if (oldWs) {
        try {
         
          if (oldWs.onopen) oldWs.onopen = null;
          if (oldWs.onclose) oldWs.onclose = null;
          if (oldWs.onmessage) oldWs.onmessage = null;
         
         
          if (oldWs.close) {
            oldWs.close(1000, 'Reconnecting');
          } else if (oldWs.sock && oldWs.sock.close) {
            oldWs.sock.close(1000, 'Reconnecting');
          }
        } catch (e) {
          // ignore
        }
        (window as any)[globalWsKey] = null;
      }
    };
    
   
    const existingWs = (window as any)[globalWsKey];
    if (existingWs && existingWs.readyState === 1) { // WebSocket.OPEN
      wsRef.current = existingWs;
      return () => {
       
        if (wsRef.current === existingWs) {
          wsRef.current = null;
        }
      };
    }
    
   
    cleanupOldConnection();
    
    const domainId = (window as any).UiContext?.domainId || 'system';
    const wsUrl = `/d/${domainId}/${basePath}/${docId}/ws`;

   
    import('../components/socket').then(({ default: WebSocket }) => {
      const ws = new WebSocket(wsUrl, false, true);
      
     
      (window as any)[globalWsKey] = ws;
      wsRef.current = ws;

      ws.onopen = () => {
       
        // console.log('[Base Outline] WebSocket connected');
      };

      ws.onmessage = (_: any, data: string) => {
        try {
          const msg = JSON.parse(data);
         
          // console.log('[Base Outline] WebSocket message:', msg);

         
          if (msg.type === 'markdown_response') {
            const { requestId, html, error } = msg;
            const requestHandler = wsRequestMapRef.current.get(requestId);
            if (requestHandler) {
              wsRequestMapRef.current.delete(requestId);
              if (error) {
                requestHandler.reject(new Error(error));
              } else {
                requestHandler.resolve(html);
              }
            }
          } else if (msg.type === 'image_response') {
            const { requestId, data: imageData, error } = msg;
            const requestHandler = wsRequestMapRef.current.get(requestId);
            if (requestHandler) {
              wsRequestMapRef.current.delete(requestId);
              if (error) {
                requestHandler.reject(new Error(error));
              } else {
                requestHandler.resolve(imageData);
              }
            }
          } else if (msg.type === 'init' || msg.type === 'update') {
           
            setTimeout(() => {
              const domainId = (window as any).UiContext?.domainId || 'system';
              const dataApiPath = basePath === 'base/skill' ? `/d/${domainId}/base/skill/data` : `/d/${domainId}/base/data`;
              const dataQs: Record<string, string> = {};
              if (docId && basePath === 'base') dataQs.docId = docId;
              const dBranch = (window as any).UiContext?.currentBranch;
              if (dBranch) dataQs.branch = dBranch;
              request.get(dataApiPath, dataQs).then((responseData) => {
                const newBase = responseData?.base || responseData;
                
               
                const currentExpandedNodes = expandedNodesRef.current;
                
               
                const mergedNodes = newBase.nodes.map((node: BaseNode) => {
                  const isCurrentlyExpanded = currentExpandedNodes.has(node.id);
                 
                  return {
                    ...node,
                    expandedOutline: currentExpandedNodes.has(node.id) ? isCurrentlyExpanded : (node.expandedOutline !== false),
                  };
                });
                
                setBase({
                  ...newBase,
                  nodes: mergedNodes,
                });
                
               
               
                setExpandedNodes(prev => {
                  const newSet = new Set(prev);
                  let changed = false;
                  mergedNodes.forEach((node: BaseNode) => {
                   
                    if (!prev.has(node.id)) {
                      if (node.expandedOutline !== false) {
                        newSet.add(node.id);
                        changed = true;
                      }
                    }
                   
                  });
                  if (changed) {
                    expandedNodesRef.current = newSet;
                  }
                  return changed ? newSet : prev;
                });
                
                if ((window as any).UiContext) {
                  const updatedMap = responseData?.nodeCardsMap
                    || responseData?.base?.nodeCardsMap
                    || {};
                  (window as any).UiContext.nodeCardsMap = updatedMap;
                  setNodeCardsMap(updatedMap);
                  
                 
                  const currentSelectedCard = selectedCard;
                  if (currentSelectedCard) {
                    const nodeCards = updatedMap[currentSelectedCard.nodeId || ''] || [];
                    const updatedCard = nodeCards.find((c: Card) => c.docId === currentSelectedCard.docId);
                    if (updatedCard) {
                     
                      if (updatedCard.updateAt && currentSelectedCard.updateAt && 
                          updatedCard.updateAt !== currentSelectedCard.updateAt) {
                       
                        setTimeout(() => {
                          const cardIdStr = String(currentSelectedCard.docId);
                          delete cardContentCacheRef.current[cardIdStr];
                          cachedCardsRef.current.delete(cardIdStr);
                          try {
                            const cacheKey = `base-outline-card-${cardIdStr}`;
                            localStorage.removeItem(cacheKey);
                          } catch (error) {
                            console.error('Failed to remove from localStorage:', error);
                          }
                        }, 0);
                      }
                     
                     
                      if (JSON.stringify(updatedCard) !== JSON.stringify(currentSelectedCard)) {
                        setSelectedCard(updatedCard);
                      }
                    } else {
                     
                      selectedFileIdRef.current = null;
                      setSelectedFileId(null);
                      setSelectedCard(null);
                    }
                  }
                  
                 
                 
                }
              }).catch((error) => {
                console.error('Failed to reload data:', error);
              });
            }, 0);
          }
        } catch (error) {
          console.error('[Base Outline] Failed to parse WebSocket message:', error);
        }
      };

      ws.onclose = (event: any) => {
        // console.log('[Base Outline] WebSocket closed', event.code, event.reason);
       
        if ((window as any)[globalWsKey] === ws) {
          (window as any)[globalWsKey] = null;
        }
       
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
       
      };

     
     
    }).catch((error) => {
      console.error('[Base Outline] Failed to load WebSocket:', error);
    });

    return () => {
     
      const currentWs = (window as any)[globalWsKey];
     
     
      if (wsRef.current === currentWs) {
        wsRef.current = null;
      }
    };
  }, [docId, basePath]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', backgroundColor: themeStyles.bgPrimary, overflow: 'hidden' }}>
      <div style={{
        padding: '10px 20px',
        background: themeStyles.bgSecondary,
        borderBottom: `1px solid ${themeStyles.borderPrimary}`,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexShrink: 0,
      }}>
        <div ref={branchDropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
            style={{
              padding: '5px 12px',
              border: `1px solid ${themeStyles.borderPrimary}`,
              borderRadius: '6px',
              background: themeStyles.bgButton,
              color: themeStyles.textPrimary,
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              lineHeight: '20px',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.7 }}>
              <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/>
            </svg>
            <span>{base.currentBranch || 'main'}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.5 }}>
              <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
            </svg>
          </button>
          {branchDropdownOpen && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              minWidth: '220px',
              background: themeStyles.bgSecondary,
              border: `1px solid ${themeStyles.borderPrimary}`,
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              zIndex: 1000,
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '8px 12px',
                borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                fontSize: '12px',
                fontWeight: 600,
                color: themeStyles.textPrimary,
              }}>
                Switch branches
              </div>
              <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                {(base.branches && base.branches.length > 0 ? base.branches : ['main']).map((b) => {
                  const isCurrent = b === (base.currentBranch || 'main');
                  const domainId = (window as any).UiContext?.domainId || 'system';
                  const href = `/d/${domainId}/base/${docId}/outline/branch/${encodeURIComponent(b)}`;
                  return (
                    <a
                      key={b}
                      href={isCurrent ? undefined : href}
                      onClick={isCurrent ? (e) => { e.preventDefault(); setBranchDropdownOpen(false); } : undefined}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        fontSize: '13px',
                        textDecoration: 'none',
                        color: themeStyles.textPrimary,
                        background: isCurrent ? (themeStyles.bgPrimary) : 'transparent',
                        fontWeight: isCurrent ? 600 : 400,
                        cursor: isCurrent ? 'default' : 'pointer',
                        borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                      }}
                      onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = themeStyles.bgPrimary; }}
                      onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <span style={{ width: '16px', textAlign: 'center' }}>
                        {isCurrent ? '✓' : ''}
                      </span>
                      <span>{b}</span>
                    </a>
                  );
                })}
              </div>
              <a
                href={(() => {
                  const domainId = (window as any).UiContext?.domainId || 'system';
                  return `/d/${domainId}/base/${docId}/branches`;
                })()}
                style={{
                  display: 'block',
                  padding: '8px 12px',
                  fontSize: '12px',
                  textAlign: 'center',
                  textDecoration: 'none',
                  color: '#4493f8',
                  borderTop: `1px solid ${themeStyles.borderPrimary}`,
                  fontWeight: 500,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = 'none'; }}
              >
                View all branches
              </a>
            </div>
          )}
        </div>
        {/* <button
          onClick={() => setShowCachePanel(!showCachePanel)}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: showCachePanel ? '#1976d2' : '#fff',
            color: showCachePanel ? '#fff' : '#333',
            cursor: 'pointer',
            fontWeight: 'bold',
            marginLeft: '10px',
          }}
          title="缓存管理"
        >
          💾 缓存
        </button> */}
        {isMobile && (
          <button
            onClick={() => setIsExplorerOpen(true)}
            style={{
              padding: '6px 12px',
              border: `1px solid ${themeStyles.borderPrimary}`,
              borderRadius: '4px',
              background: themeStyles.bgButton,
              color: themeStyles.textPrimary,
              cursor: 'pointer',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            title="展开EXPLORER"
          >
            <span>📁</span>
            <span>EXPLORER</span>
          </button>
        )}
        <div style={{ marginLeft: 'auto', fontSize: '14px', color: themeStyles.textSecondary }}>
          {base.title} - 文件模式
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, width: '100%', position: 'relative', backgroundColor: themeStyles.bgPrimary, minHeight: 0, overflow: 'hidden' }}>
        {/* {showCachePanel && (
          <div style={{
            width: '280px',
            borderRight: '1px solid #e0e0e0',
            backgroundColor: '#fff',
            overflow: 'auto',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{
              padding: '16px',
              borderBottom: '1px solid #e0e0e0',
              backgroundColor: '#f6f8fa',
            }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#333' }}>
                💾 缓存管理
              </h3>
            </div>
            <div style={{ padding: '16px', flex: 1 }}>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>缓存统计</div>
                <div style={{ fontSize: '13px', color: '#333', marginBottom: '4px' }}>
                  已缓存: {cachedCount} 个卡片
                </div>
                <div style={{ fontSize: '13px', color: '#333' }}>
                  缓存大小: {formatCacheSize(getCacheSize())}
                </div>
              </div>

              {cachingProgress && (
                <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f6f8fa', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>📄 卡片缓存进度</div>
                  <div style={{ 
                    width: '100%', 
                    height: '8px', 
                    backgroundColor: '#e0e0e0', 
                    borderRadius: '4px',
                    overflow: 'hidden',
                    marginBottom: '8px',
                  }}>
                    <div style={{
                      width: `${(cachingProgress.current / cachingProgress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#4caf50',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', textAlign: 'center' }}>
                    {cachingProgress.current} / {cachingProgress.total}
                  </div>
                </div>
              )}

              {imageCachingProgress && (
                <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#fff3e0', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>🖼️ 图片缓存进度</div>
                  <div style={{ 
                    width: '100%', 
                    height: '8px', 
                    backgroundColor: '#e0e0e0', 
                    borderRadius: '4px',
                    overflow: 'hidden',
                    marginBottom: '8px',
                  }}>
                    <div style={{
                      width: `${(imageCachingProgress.current / imageCachingProgress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#ff9800',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', textAlign: 'center' }}>
                    {imageCachingProgress.current} / {imageCachingProgress.total}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {isCachingPaused ? (
                  <button
                    onClick={startCaching}
                    style={{
                      padding: '8px 16px',
                      border: 'none',
                      borderRadius: '4px',
                      background: '#4caf50',
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '13px',
                    }}
                  >
                    ▶ 开始缓存
                  </button>
                ) : (
                  <button
                    onClick={pauseCaching}
                    style={{
                      padding: '8px 16px',
                      border: 'none',
                      borderRadius: '4px',
                      background: '#ff9800',
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '13px',
                    }}
                  >
                    ⏸ 暂停缓存
                  </button>
                )}
                <button
                  onClick={clearCache}
                  style={{
                    padding: '8px 16px',
                    border: 'none',
                    borderRadius: '4px',
                    background: '#f44336',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '13px',
                  }}
                >
                  🗑 清空缓存
                </button>
              </div>
            </div>
          </div>
        )} */}

        {isMobile && isExplorerOpen && (
          <div
            onClick={() => setIsExplorerOpen(false)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              zIndex: 998,
            }}
          />
        )}
        
        <div style={{
          width: isMobile ? '280px' : '300px',
          borderRight: `1px solid ${themeStyles.borderPrimary}`,
          backgroundColor: themeStyles.bgSecondary,
          overflowY: 'auto',
          overflowX: 'hidden',
          flexShrink: 0,
          ...(isMobile ? {
            position: 'fixed',
            left: isExplorerOpen ? 0 : '-280px',
            top: 0,
            bottom: 0,
            height: '100vh',
            zIndex: 999,
            transition: 'left 0.3s ease',
            boxShadow: isExplorerOpen ? '2px 0 8px rgba(0,0,0,0.15)' : 'none',
          } : {
            alignSelf: 'stretch',
          }),
        }}>
          <div style={{ padding: '8px' }} data-file-tree-container>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', padding: '0 8px' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: themeStyles.textSecondary, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>EXPLORER</span>
                {isMobile && (
                  <button
                    onClick={() => setIsExplorerOpen(false)}
                    style={{
                      padding: '2px 6px',
                      border: 'none',
                      borderRadius: '3px',
                      background: themeStyles.borderPrimary,
                      color: themeStyles.textPrimary,
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 'bold',
                    }}
                    title="关闭"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <button
                  onClick={() => setExplorerMode('tree')}
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: '3px',
                    backgroundColor: explorerMode === 'tree' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                    color: explorerMode === 'tree' ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                  title="文件结构"
                >
                  文件结构
                </button>
                <button
                  onClick={() => {
                    setExplorerMode('cache');
                   
                    setTimeout(() => {
                      if (!isCheckingCache && cachedCardsRef.current.size > 0) {
                        checkCacheStatus();
                      }
                    }, 300);
                  }}
                  style={{
                    padding: '2px 8px',
                    fontSize: '11px',
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    borderRadius: '3px',
                    backgroundColor: explorerMode === 'cache' ? themeStyles.bgButtonActive : themeStyles.bgButton,
                    color: explorerMode === 'cache' ? themeStyles.textOnPrimary : themeStyles.textPrimary,
                    cursor: 'pointer',
                    position: 'relative',
                  }}
                  title="缓存管理"
                >
                  <span>缓存</span>
                  {cacheStatus && cacheStatus.outdated.length > 0 && (
                    <span style={{
                      position: 'absolute',
                      top: '-4px',
                      right: '-4px',
                      width: '12px',
                      height: '12px',
                      backgroundColor: '#f44336',
                      borderRadius: '50%',
                      border: '2px solid #fff',
                      fontSize: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontWeight: 'bold',
                    }}>
                      {cacheStatus.outdated.length > 9 ? '9+' : cacheStatus.outdated.length}
                    </span>
                  )}
                </button>
              </div>
            </div>
            

            {explorerMode === 'tree' ? (
             
              null
            ) : (
             
              <div>
                {cacheStatus ? (
                  <div>
                    <div style={{
                      marginBottom: '8px',
                      padding: '8px',
                      backgroundColor: cacheStatus.outdated.length > 0 ? '#fff3e0' : '#e8f5e9',
                      borderRadius: '4px',
                      border: `1px solid ${cacheStatus.outdated.length > 0 ? '#ff9800' : '#4caf50'}`,
                      fontSize: '11px',
                    }}>
                      <div style={{ fontWeight: '600', color: cacheStatus.outdated.length > 0 ? '#e65100' : '#2e7d32', marginBottom: '8px' }}>
                        {cacheStatus.outdated.length > 0 ? `⚠️ ${cacheStatus.outdated.length} 个缓存需要更新` : `✅ 所有缓存都是最新的`}
                      </div>
                      {cacheStatus.outdated.length > 0 && (
                        <>
                          <div style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '8px' }}>
                            {cacheStatus.outdated.map(item => (
                              <div key={item.cardId} style={{
                                padding: '6px 8px',
                                marginBottom: '4px',
                                backgroundColor: '#fff',
                                borderRadius: '2px',
                                fontSize: '11px',
                                color: '#666',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                border: '1px solid #e0e0e0',
                              }}>
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {item.title}
                                </span>
                                <span style={{ marginLeft: '8px', color: '#999', fontSize: '10px', whiteSpace: 'nowrap' }}>
                                  {item.cachedUpdateAt !== '未知' ? new Date(item.cachedUpdateAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '旧格式'}
                                </span>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={updateOutdatedCache}
                            disabled={isUpdatingCache}
                            style={{
                              width: '100%',
                              padding: '8px',
                              backgroundColor: isUpdatingCache ? '#ccc' : '#4caf50',
                              color: '#fff',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '12px',
                              fontWeight: '500',
                              cursor: isUpdatingCache ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '6px',
                            }}
                            onMouseEnter={(e) => {
                              if (!isUpdatingCache) {
                                e.currentTarget.style.backgroundColor = '#388e3c';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isUpdatingCache) {
                                e.currentTarget.style.backgroundColor = '#4caf50';
                              }
                            }}
                          >
                            <span>{isUpdatingCache ? '⏳' : '🔄'}</span>
                            <span>{isUpdatingCache ? '更新中...' : '更新所有'}</span>
                          </button>
                          {cachingProgress && isUpdatingCache && (
                            <div style={{ marginTop: '8px', padding: '4px', backgroundColor: '#fff', borderRadius: '2px' }}>
                              <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px', textAlign: 'center' }}>
                                {cachingProgress.currentCard && `${cachingProgress.currentCard} - `}
                                {cachingProgress.current} / {cachingProgress.total}
                              </div>
                              <div style={{
                                width: '100%',
                                height: '6px',
                                backgroundColor: '#e0e0e0',
                                borderRadius: '3px',
                                overflow: 'hidden',
                              }}>
                                <div style={{
                                  width: `${(cachingProgress.current / cachingProgress.total) * 100}%`,
                                  height: '100%',
                                  backgroundColor: '#4caf50',
                                  transition: 'width 0.3s ease',
                                }} />
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{
                    padding: '16px',
                    textAlign: 'center',
                    color: '#999',
                    fontSize: '12px',
                  }}>
                    {isCheckingCache ? '检查中...' : '点击"文件结构"按钮查看文件，或等待自动检查缓存状态'}
                  </div>
                )}
              </div>
            )}
            {explorerMode === 'tree' && fileTree.map((file) => {
             
              let isCached = false;
              if (file.type === 'card') {
               
                const cardIdStr = String(file.cardId);
                isCached = cachedCardsRef.current.has(cardIdStr);
              } else if (file.type === 'node') {
               
                isCached = checkNodeCached(file.nodeId || '');
              }
              
             
              const isSelected = selectedFileIdRef.current === file.id && selectedFileId === file.id;
              
              return (
                <div
                  key={file.id}
                  data-file-item
                  data-file-id={file.id}
                  data-file-card-id={file.type === 'card' ? String(file.cardId) : undefined}
                  data-file-node-id={file.type === 'node' ? file.nodeId : undefined}
                  data-cached={isCached ? 'true' : 'false'}
                  onClick={() => {
                   
                    if (longPressTriggeredRef.current) {
                      longPressTriggeredRef.current = false;
                      return;
                    }
                    
                   
                    clearAllHighlights();
                    
                   
                    selectedFileIdRef.current = file.id;
                    setSelectedFileId(file.id);
                    
                    if (file.type === 'card') {
                      const nodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                      const nodeCards = nodeCardsMap[file.nodeId || ''] || [];
                      const card = nodeCards.find((c: Card) => c.docId === file.cardId);
                      if (card) {
                       
                        isManualSelectionRef.current = true;
                        handleSelectCard(card);
                        setSelectedNodeId(null);
                       
                      }
                    } else {
                     
                      const nodeId = file.nodeId || null;
                      
                     
                      isManualSelectionRef.current = true;
                     
                      clearAllHighlights();
                      
                      setSelectedNodeId(nodeId);
                      setSelectedCard(null);
                     
                      selectedFileIdRef.current = nodeId || null;
                      setSelectedFileId(nodeId || null);
                      
                     
                      const urlParams = new URLSearchParams(window.location.search);
                      if (nodeId) {
                        urlParams.set('nodeId', nodeId);
                        urlParams.delete('cardId');
                      } else {
                        urlParams.delete('nodeId');
                      }
                      const newUrl = window.location.pathname + '?' + urlParams.toString();
                      window.history.pushState({ nodeId }, '', newUrl);
                    }
                    
                   
                    if (isMobile) {
                      setIsExplorerOpen(false);
                    }
                  }}
                  onContextMenu={(e) => {
                   
                    if (!isMobile) {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, file });
                    }
                  }}
                  onTouchStart={(e) => {
                   
                    if (!isMobile) return;
                    
                    const touch = e.touches[0];
                    const startX = touch.clientX;
                    const startY = touch.clientY;
                    const startTime = Date.now();
                    let touchMoved = false;
                    let longPressTimer: NodeJS.Timeout | null = null;
                    
                    const handleTouchMove = (moveEvent: TouchEvent) => {
                      const moveTouch = moveEvent.touches[0];
                      const moveX = moveTouch.clientX;
                      const moveY = moveTouch.clientY;
                      const distance = Math.sqrt(
                        Math.pow(moveX - startX, 2) + Math.pow(moveY - startY, 2)
                      );
                     
                      if (distance > 10) {
                        touchMoved = true;
                        document.removeEventListener('touchend', handleTouchEnd);
                        document.removeEventListener('touchmove', handleTouchMove);
                        if (longPressTimer) {
                          clearTimeout(longPressTimer);
                          longPressTimer = null;
                        }
                      }
                    };
                    
                    const handleTouchEnd = (endEvent: TouchEvent) => {
                      const endTime = Date.now();
                      const duration = endTime - startTime;
                      const endTouch = endEvent.changedTouches[0];
                      const endX = endTouch.clientX;
                      const endY = endTouch.clientY;
                      const distance = Math.sqrt(
                        Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2)
                      );
                      
                      document.removeEventListener('touchend', handleTouchEnd);
                      document.removeEventListener('touchmove', handleTouchMove);
                      if (longPressTimer) {
                        clearTimeout(longPressTimer);
                        longPressTimer = null;
                      }
                      
                     
                      if (duration >= 500 && distance < 10 && !touchMoved) {
                        longPressTriggeredRef.current = true;
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: endX, y: endY, file });
                      } else {
                       
                        setTimeout(() => {
                          longPressTriggeredRef.current = false;
                        }, 300);
                      }
                    };
                    
                   
                    longPressTimer = setTimeout(() => {
                      if (!touchMoved && e.touches[0]) {
                        const currentTouch = e.touches[0];
                        longPressTriggeredRef.current = true;
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: currentTouch.clientX, y: currentTouch.clientY, file });
                      }
                    }, 500);
                    
                    document.addEventListener('touchend', handleTouchEnd, { once: true });
                    document.addEventListener('touchmove', handleTouchMove, { once: true });
                  }}
                  style={{
                    padding: `4px ${8 + file.level * 16}px`,
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: isSelected ? themeStyles.accent : (isCached ? themeStyles.textPrimary : themeStyles.textTertiary),
                    fontWeight: isSelected ? '600' : (isCached ? '600' : 'normal'),
                    backgroundColor: isSelected ? themeStyles.bgSelected : 'transparent',
                    borderLeft: isSelected ? `3px solid ${themeStyles.accent}` : '3px solid transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'background-color 0.2s, border-color 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = isSelected ? themeStyles.bgSelected : 'transparent';
                  }}
                >
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
                        }}
                      >
                        {expandedNodes.has(file.nodeId || '') ? '▼' : '▶'}
                      </span>
                      <span style={{ fontSize: '16px', flexShrink: 0 }}>📁</span>
                    </>
                  ) : (
                    <span style={{ fontSize: '16px', flexShrink: 0 }}>📄</span>
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {selectedCard ? (
          <div style={{
            flex: 1,
            borderLeft: `1px solid ${themeStyles.borderPrimary}`,
            backgroundColor: themeStyles.bgPrimary,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              backgroundColor: themeStyles.bgSecondary,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: themeStyles.textPrimary }}>
                  {selectedCard.title || '未命名卡片'}
                </h3>
                <a
                  href={(() => {
                    const domainId = (window as any).UiContext?.domainId || 'system';
                    const branch = (window as any).UiContext?.currentBranch || 'main';
                    const baseDocId = (window as any).UiContext?.base?.docId;
                    const basebid = (window as any).UiContext?.base?.bid;
                    const nodeId = selectedCard.nodeId || '';
                    const cardId = selectedCard.docId;
                    
                    const docSeg = baseDocId != null && String(baseDocId).trim()
                      ? String(baseDocId).trim()
                      : (basebid && String(basebid).trim() ? String(basebid).trim() : '');
                    if (docSeg) {
                      return `/d/${domainId}/base/${encodeURIComponent(docSeg)}/branch/${branch}/node/${encodeURIComponent(nodeId)}/card/${cardId}/edit?returnUrl=${encodeURIComponent(window.location.href)}`;
                    }
                    return '#';
                  })()}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: themeStyles.accent,
                    color: themeStyles.textOnPrimary,
                    textDecoration: 'none',
                    borderRadius: '4px',
                    fontSize: '13px',
                    fontWeight: '500',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = theme === 'dark' ? '#4a9fd4' : '#1565c0';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.accent;
                  }}
                >
                  <span>✎</span>
                  <span>编辑</span>
                </a>
              </div>
              {cachingProgress && (
                <div style={{
                  marginTop: '12px',
                  padding: '8px 12px',
                  backgroundColor: themeStyles.bgPrimary,
                  borderRadius: '4px',
                  border: `1px solid ${themeStyles.borderPrimary}`,
                }}>
                  <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '6px' }}>
                    正在缓存同节点下的其他卡片...
                  </div>
                  <div style={{ 
                    width: '100%', 
                    height: '6px', 
                    backgroundColor: themeStyles.borderPrimary, 
                    borderRadius: '3px',
                    overflow: 'hidden',
                    marginBottom: '4px',
                  }}>
                    <div style={{
                      width: `${(cachingProgress.current / cachingProgress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#4caf50',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '11px', color: themeStyles.textTertiary, textAlign: 'center' }}>
                    {cachingProgress.current} / {cachingProgress.total}
                    {cachingProgress.currentCard && ` - ${cachingProgress.currentCard}`}
                  </div>
                </div>
              )}
            </div>
            <div style={{
              flex: 1,
              minHeight: 0,
              padding: '16px',
              overflow: 'auto',
              WebkitOverflowScrolling: 'touch',
            }}>
              <style dangerouslySetInnerHTML={{ __html: `
                #card-content-outline img, #card-content-outline .typo img, .topic__content img {
                  max-width: 100% !important;
                  height: auto !important;
                  max-height: min(70vh, 600px);
                  object-fit: contain;
                  display: block;
                  margin: 8px 0;
                }
                @media (max-width: 600px) {
                  #card-content-outline img, #card-content-outline .typo img, .topic__content img {
                    max-height: min(50vh, 400px);
                  }
                }
              ` }} />
              <div
                id="card-content-outline"
                className="typo topic__content richmedia"
                data-emoji-enabled
                style={{
                  padding: '16px',
                  overflowWrap: 'break-word',
                  wordBreak: 'break-word',
                }}
                dangerouslySetInnerHTML={{ __html: '<p style="color: #999;">加载中...</p>' }}
              />
            </div>
          </div>
        ) : selectedNodeId ? (
          <div style={{
            flex: 1,
            borderLeft: `1px solid ${themeStyles.borderPrimary}`,
            backgroundColor: themeStyles.bgPrimary,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{
              padding: '16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              backgroundColor: themeStyles.bgSecondary,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: themeStyles.textPrimary }}>
                  {base.nodes.find(n => n.id === selectedNodeId)?.text || '未命名节点'}
                </h3>
              </div>
            </div>
            <div style={{
              flex: 1,
              overflow: 'auto',
            }}>
              {(() => {
                const subgraph = getNodeSubgraph(selectedNodeId);
                return (
        <OutlineView
                    nodes={subgraph.nodes}
                    edges={subgraph.edges}
                    onToggleExpand={handleNodeToggleExpand}
                    onNodeClick={handleNodeClick}
          selectedNodeId={selectedNodeId}
                    rootNodeId={selectedNodeId}
                    basePath={basePath}
        />
                );
              })()}
            </div>
          </div>
        ) : (
          <div style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: themeStyles.bgPrimary,
            color: themeStyles.textTertiary,
            fontSize: '14px',
          }}>
            请从左侧选择一个节点或卡片
          </div>
        )}
      </div>

      {contextMenu && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999,
            }}
            onClick={() => setContextMenu(null)}
            onTouchStart={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: isMobile ? Math.max(10, Math.min(contextMenu.x, window.innerWidth - 190)) : contextMenu.x,
              top: isMobile ? Math.max(10, Math.min(contextMenu.y, window.innerHeight - 100)) : contextMenu.y,
              backgroundColor: themeStyles.bgPrimary,
              border: `1px solid ${themeStyles.borderPrimary}`,
              borderRadius: '8px',
              boxShadow: theme === 'dark' ? '0 4px 12px rgba(0,0,0,0.5)' : '0 4px 12px rgba(0,0,0,0.2)',
              zIndex: 1000,
              minWidth: isMobile ? '160px' : '180px',
              padding: '8px 0',
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {contextMenu.file.type === 'card' ? (
              <>
                {basePath !== 'base/skill' && contextMenu.file.cardId ? (
                  <>
                    <div
                      style={{
                        padding: isMobile ? '12px 16px' : '6px 16px',
                        cursor: learnOutlineBusy ? 'wait' : 'pointer',
                        fontSize: isMobile ? '15px' : '13px',
                        color: themeStyles.textPrimary,
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        opacity: learnOutlineBusy ? 0.65 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!isMobile && !learnOutlineBusy) {
                          e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isMobile) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }
                      }}
                      onTouchStart={(e) => {
                        if (!learnOutlineBusy) e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                      }}
                      onTouchEnd={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      onClick={() => {
                        const cid = contextMenu.file.cardId;
                        if (cid) void startSingleCardLearnFromOutline(cid);
                        setContextMenu(null);
                      }}
                    >
                      {i18n('Outline learn single card')}
                    </div>
                    <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                  </>
                ) : null}
                <div
                  style={{
                    padding: isMobile ? '12px 16px' : '6px 16px',
                    cursor: 'pointer',
                    fontSize: isMobile ? '15px' : '13px',
                    color: themeStyles.textPrimary,
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (!isMobile) {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isMobile) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                  onTouchStart={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onTouchEnd={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    if (contextMenu.file.cardId) {
                      clearCardCache(contextMenu.file.cardId);
                    }
                    setContextMenu(null);
                  }}
                >
                  🗑 清除缓存
                </div>
              </>
            ) : (
              <>
                {contextMenu.file.type === 'node' && contextMenu.file.nodeId && basePath !== 'base/skill' ? (
                  <>
                    <div
                      style={{
                        padding: isMobile ? '12px 16px' : '6px 16px',
                        cursor: outlineStartBusy ? 'wait' : 'pointer',
                        fontSize: isMobile ? '15px' : '13px',
                        color: themeStyles.textPrimary,
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        opacity: outlineStartBusy ? 0.65 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!isMobile && !outlineStartBusy) {
                          e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isMobile) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }
                      }}
                      onClick={() => {
                        const nid = contextMenu.file.nodeId;
                        if (nid) void startEditorSessionFromOutline(nid);
                        setContextMenu(null);
                      }}
                    >
                      {i18n('Outline editor start session')}
                    </div>
                    <div
                      style={{
                        padding: isMobile ? '12px 16px' : '6px 16px',
                        cursor: learnOutlineBusy ? 'wait' : 'pointer',
                        fontSize: isMobile ? '15px' : '13px',
                        color: themeStyles.textPrimary,
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        opacity: learnOutlineBusy ? 0.65 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!isMobile && !learnOutlineBusy) {
                          e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isMobile) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }
                      }}
                      onClick={() => {
                        const nid = contextMenu.file.nodeId;
                        if (nid) void startSingleNodeLearnFromOutline(nid);
                        setContextMenu(null);
                      }}
                    >
                      {i18n('Outline learn single node')}
                    </div>
                    <div style={{ height: '1px', backgroundColor: themeStyles.borderSecondary, margin: '4px 0' }} />
                  </>
                ) : null}
                <div
                  style={{
                    padding: isMobile ? '12px 16px' : '6px 16px',
                    cursor: 'pointer',
                    fontSize: isMobile ? '15px' : '13px',
                    color: themeStyles.textPrimary,
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (!isMobile) {
                      e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isMobile) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                  onTouchStart={(e) => {
                    e.currentTarget.style.backgroundColor = themeStyles.bgHover;
                  }}
                  onTouchEnd={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  onClick={() => {
                    if (contextMenu.file.nodeId) {
                      clearNodeCache(contextMenu.file.nodeId);
                    }
                    setContextMenu(null);
                  }}
                >
                  🗑 清除节点缓存
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}


const getBaseUrl = (path: string, docId: string): string => {
  const domainId = (window as any).UiContext?.domainId || 'system';
  return `/d/${domainId}/base/${docId}${path}`;
};

const page = new NamedPage(['base_outline', 'base_skill_outline', 'base_outline_doc', 'base_outline_doc_branch'], async (pageName) => {
  try {
   
    const isSkill = pageName === 'base_skill_outline';
    const containerId = isSkill ? '#skill-outline-editor' : '#base-outline-editor';
    const $container = $(containerId);
    if (!$container.length) {
      return;
    }

    const domainId = (window as any).UiContext?.domainId || 'system';
    const docId = ($container.data('doc-id') || $container.attr('data-doc-id') || '') as string;

   
    let initialData: BaseDoc;
    try {
     
      const apiPath = isSkill ? `/d/${domainId}/base/skill/data` : `/d/${domainId}/base/data`;
      const branch = (window as any).UiContext?.currentBranch || undefined;
      const params: Record<string, string> = {};
      if (docId) params.docId = docId;
      if (branch) params.branch = branch;
      const response = await request.get(apiPath, params);
      initialData = response;
     
      if (!initialData.docId) {
        initialData.docId = docId || '';
      }
      if (!initialData.branches) {
        const bd = (initialData as any).branchData;
        const brSet = new Set<string>(['main']);
        if (bd && typeof bd === 'object') {
          Object.keys(bd).forEach((k) => brSet.add(k));
        }
        initialData.branches = Array.from(brSet);
      }
      if (!initialData.currentBranch) {
        initialData.currentBranch = (window as any).UiContext?.currentBranch || 'main';
      }
    } catch (error: any) {
      console.error('[BaseOutline] Failed to load data:', error);
      Notification.error(`加载${isSkill ? 'Skills' : '知识库'}失败: ` + (error.message || '未知错误'));
      return;
    }

    console.log('[BaseOutline] Rendering BaseOutlineEditor...');
    ReactDOM.render(
      <BaseOutlineEditor docId={initialData.docId || ''} initialData={initialData} basePath={isSkill ? 'base/skill' : 'base'} />,
      $container[0]
    );
    console.log('[BaseOutline] Render complete');
  } catch (error: any) {
    console.error('[BaseOutline] Failed to initialize outline editor:', error);
    Notification.error('初始化文件模式编辑器失败: ' + (error.message || '未知错误'));
  }
});

export default page;


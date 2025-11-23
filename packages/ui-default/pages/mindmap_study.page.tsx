import $ from 'jquery';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import Notification from 'vj/components/notification';
import { request } from 'vj/utils';
import ReactFlow, {
  Node,
  Edge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  NodeTypes,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css';

interface MindMapNode {
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
  level?: number;
  style?: Record<string, any>;
  data?: Record<string, any>;
}

interface MindMapEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: Record<string, any>;
  type?: 'straight' | 'curved' | 'bezier';
  color?: string;
  width?: number;
}

interface MindMapDoc {
  docId: string;
  mmid: number;
  title: string;
  content: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
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
}

// 思维导图节点组件（用于刷题）
const StudyMindMapNodeComponent = ({ data, selected, id }: { data: any; selected: boolean; id: string }) => {
  const node = data.originalNode as MindMapNode;
  const shape = node.shape || 'rectangle';
  const backgroundColor = node.backgroundColor || (selected ? '#e3f2fd' : '#fff');
  const color = node.color || '#333';
  const fontSize = node.fontSize || 14;
  const isHidden = data.isHidden || false; // 是否被遮住
  
  const shapeStyles: Record<string, React.CSSProperties> = {
    rectangle: {
      borderRadius: '8px',
      padding: '10px 15px',
    },
    circle: {
      borderRadius: '50%',
      padding: '10px',
      width: '80px',
      height: '80px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    ellipse: {
      borderRadius: '50%',
      padding: '10px 20px',
    },
    diamond: {
      transform: 'rotate(45deg)',
      padding: '10px',
      width: '80px',
      height: '80px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
  };

  const textStyle: React.CSSProperties = {
    transform: shape === 'diamond' ? 'rotate(-45deg)' : 'none',
    textAlign: 'center',
  };

  return (
    <div
      style={{
        ...shapeStyles[shape],
        background: backgroundColor,
        border: `2px solid ${selected ? '#1976d2' : color}`,
        minWidth: shape === 'circle' || shape === 'diamond' ? '80px' : '120px',
        boxShadow: selected ? '0 4px 8px rgba(0,0,0,0.2)' : '0 2px 4px rgba(0,0,0,0.1)',
        position: 'relative',
        color: color,
        fontSize: `${fontSize}px`,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: color,
          width: '10px',
          height: '10px',
          border: '2px solid #fff',
        }}
      />

      {isHidden ? (
        <div style={{
          ...textStyle,
          position: 'relative',
          minHeight: '20px',
        }}>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
          }}>
            <span style={{ fontSize: '14px', color: '#999' }}>?</span>
          </div>
        </div>
      ) : (
        <div style={textStyle}>
          {node.text || '未命名节点'}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: color,
          width: '10px',
          height: '10px',
          border: '2px solid #fff',
        }}
      />
    </div>
  );
};

const customNodeTypes: NodeTypes = {
  mindmap: StudyMindMapNodeComponent,
};

// 使用 dagre 自动布局
const getLayoutedElements = (nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'LR') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ 
    rankdir: direction,
    nodesep: 100,
    ranksep: 150,
    marginx: 50,
    marginy: 50,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 150, height: 80 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 75,
        y: nodeWithPosition.y - 40,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

// 卡片组件
const StudyCard = ({
  parent,
  children,
  showChildren,
  onToggleShow,
  cardIndex,
  totalCards,
  onNext,
  onPrev,
  currentLayer,
  totalLayers,
}: {
  parent: MindMapNode;
  children: MindMapNode[];
  showChildren: boolean;
  onToggleShow: () => void;
  cardIndex: number;
  totalCards: number;
  onNext: () => void;
  onPrev: () => void;
  currentLayer?: number;
  totalLayers?: number;
}) => {
  // 构建节点和边
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(() => {
    const nodes: Node[] = [
      {
        id: parent.id,
        type: 'mindmap',
        position: { x: 0, y: 0 },
        data: {
          originalNode: parent,
          isHidden: false,
        },
      },
    ];

    const edges: Edge[] = [];

    children.forEach((child, index) => {
      nodes.push({
        id: child.id,
        type: 'mindmap',
        position: { x: 0, y: 0 },
        data: {
          originalNode: child,
          isHidden: !showChildren,
        },
      });

      edges.push({
        id: `edge-${parent.id}-${child.id}`,
        source: parent.id,
        target: child.id,
        type: 'smoothstep',
        animated: true,
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
        style: {
          stroke: '#2196f3',
          strokeWidth: 2,
        },
      });
    });

    return getLayoutedElements(nodes, edges);
  }, [parent, children, showChildren]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  // 当布局变化时更新节点和边
  useEffect(() => {
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      {/* 卡片进度 */}
      <div style={{ marginBottom: '20px', fontSize: '14px', color: '#666', textAlign: 'center' }}>
        {cardIndex + 1} / {totalCards}
        {currentLayer !== undefined && totalLayers !== undefined && (
          <span style={{ marginLeft: '20px' }}>
            第 {currentLayer} 层，还有 {totalLayers - currentLayer} 层
          </span>
        )}
      </div>

      {/* 思维导图卡片 */}
      <div
        style={{
          width: '100%',
          maxWidth: '1000px',
          height: '500px',
          border: '2px solid #2196F3',
          borderRadius: '12px',
          background: '#fff',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          position: 'relative',
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={customNodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={true}
          zoomOnScroll={true}
        >
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
          <Controls />
        </ReactFlow>
      </div>

      {/* 显示/隐藏按钮 */}
      <div style={{ textAlign: 'center', marginTop: '20px' }}>
        <button
          onClick={onToggleShow}
          style={{
            padding: '12px 24px',
            border: '1px solid #2196f3',
            borderRadius: '4px',
            background: showChildren ? '#f5f5f5' : '#2196f3',
            color: showChildren ? '#333' : '#fff',
            cursor: 'pointer',
            fontSize: '16px',
          }}
        >
          {showChildren ? '隐藏答案' : '显示答案'}
        </button>
      </div>

      {/* 控制按钮 */}
      <div style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'center' }}>
        <button
          onClick={onPrev}
          disabled={cardIndex === 0}
          style={{
            padding: '12px 24px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: cardIndex === 0 ? '#f5f5f5' : '#fff',
            color: cardIndex === 0 ? '#999' : '#333',
            cursor: cardIndex === 0 ? 'not-allowed' : 'pointer',
            fontSize: '16px',
          }}
        >
          上一个
        </button>
        <button
          onClick={onNext}
          disabled={cardIndex >= totalCards - 1}
          style={{
            padding: '12px 24px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: cardIndex >= totalCards - 1 ? '#f5f5f5' : '#4caf50',
            color: cardIndex >= totalCards - 1 ? '#999' : '#fff',
            cursor: cardIndex >= totalCards - 1 ? 'not-allowed' : 'pointer',
            fontSize: '16px',
          }}
        >
          下一个
        </button>
      </div>
    </div>
  );
};

function MindMapStudy() {
  const [mindMap, setMindMap] = useState<MindMapDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [studyMode, setStudyMode] = useState<'breadth' | 'depth'>('breadth');
  const [selectedLayer, setSelectedLayer] = useState<number | null>(null);
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [showChildren, setShowChildren] = useState(false);
  // 深度模式：选中的顶层子节点
  const [selectedTopLevelNode, setSelectedTopLevelNode] = useState<MindMapNode | null>(null);

  // 从 URL 获取 docId
  const docId = useMemo(() => {
    const pathParts = window.location.pathname.split('/').filter(p => p);
    const mindmapIndex = pathParts.indexOf('mindmap');
    if (mindmapIndex >= 0 && mindmapIndex < pathParts.length - 1) {
      return pathParts[mindmapIndex + 1];
    }
    return '';
  }, []);

  // 加载思维导图数据
  useEffect(() => {
    const loadMindMap = async () => {
      if (!docId) {
        Notification.error('思维导图ID未找到');
        setLoading(false);
        return;
      }

      try {
        const response = await request.get(`/mindmap/${docId}/data`);
        setMindMap(response);
      } catch (error: any) {
        Notification.error('加载思维导图失败: ' + (error.message || '未知错误'));
      } finally {
        setLoading(false);
      }
    };

    loadMindMap();
  }, [docId]);

  // 按层组织节点（广度优先，跳过根节点，从根节点的子节点开始作为第0层）
  // 每一层只包含有子节点的节点（用于刷题）
  const nodesByLayer = useMemo(() => {
    if (!mindMap) return [];
    
    const layers: { layer: number; nodes: MindMapNode[] }[] = [];
    const visited = new Set<string>();
    const nodeMap = new Map<string, MindMapNode>();
    
    mindMap.nodes.forEach(node => {
      nodeMap.set(node.id, node);
    });

    // 找到根节点（没有父边的节点）
    const rootNodes = mindMap.nodes.filter(node => 
      !mindMap.edges.some(edge => edge.target === node.id)
    );

    if (rootNodes.length === 0) return layers;

    // 从根节点的子节点开始，作为第0层
    const queue: { nodeId: string; layer: number }[] = [];
    rootNodes.forEach(root => {
      // 不添加根节点，直接添加根节点的子节点
      const childEdges = mindMap.edges.filter(e => e.source === root.id);
      for (const edge of childEdges) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ nodeId: edge.target, layer: 0 });
        }
      }
    });

    while (queue.length > 0) {
      const { nodeId, layer } = queue.shift()!;
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      // 检查该节点是否有子节点
      const childEdges = mindMap.edges.filter(e => e.source === nodeId);
      const hasChildren = childEdges.length > 0;

      // 只有有子节点的节点才添加到层中（用于刷题）
      if (hasChildren) {
        // 确保层数组有足够的空间
        while (layers.length <= layer) {
          layers.push({ layer: layers.length, nodes: [] });
        }
        layers[layer].nodes.push(node);
      }

      // 添加子节点到队列（无论是否有子节点，都要继续遍历）
      for (const edge of childEdges) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ nodeId: edge.target, layer: layer + 1 });
        }
      }
    }

    return layers;
  }, [mindMap]);

  // 获取当前层的卡片列表（每个有子节点的节点生成一张卡片）
  const currentLayerCards = useMemo(() => {
    if (selectedLayer === null || selectedLayer >= nodesByLayer.length) return [];
    const layerNodes = nodesByLayer[selectedLayer].nodes;
    return layerNodes.map(node => {
      const childEdges = mindMap?.edges.filter(e => e.source === node.id) || [];
      const children = childEdges.map(e => {
        const childNode = mindMap?.nodes.find(n => n.id === e.target);
        return childNode || null;
      }).filter(Boolean) as MindMapNode[];

      return {
        parent: node,
        children,
      };
    });
  }, [selectedLayer, nodesByLayer, mindMap]);

  // 获取根节点的顶层子节点（用于深度模式）
  const topLevelNodes = useMemo(() => {
    if (!mindMap) return [];
    const rootNodes = mindMap.nodes.filter(node => 
      !mindMap.edges.some(edge => edge.target === node.id)
    );
    if (rootNodes.length === 0) return [];
    
    // 获取根节点的所有直接子节点
    const topLevelNodes: MindMapNode[] = [];
    rootNodes.forEach(root => {
      const childEdges = mindMap.edges.filter(e => e.source === root.id);
      childEdges.forEach(edge => {
        const childNode = mindMap.nodes.find(n => n.id === edge.target);
        if (childNode) {
          topLevelNodes.push(childNode);
        }
      });
    });
    
    return topLevelNodes;
  }, [mindMap]);

  // 深度模式：按层组织选中节点的子树（广度优先）
  const depthNodesByLayer = useMemo(() => {
    if (!selectedTopLevelNode || !mindMap) return [];
    
    const layers: { layer: number; nodes: MindMapNode[] }[] = [];
    const visited = new Set<string>();
    const nodeMap = new Map<string, MindMapNode>();
    
    mindMap.nodes.forEach(node => {
      nodeMap.set(node.id, node);
    });

    // 从选中的顶层节点开始，作为第0层
    const queue: { nodeId: string; layer: number }[] = [];
    queue.push({ nodeId: selectedTopLevelNode.id, layer: 0 });
    visited.add(selectedTopLevelNode.id);

    while (queue.length > 0) {
      const { nodeId, layer } = queue.shift()!;
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      // 检查该节点是否有子节点
      const childEdges = mindMap.edges.filter(e => e.source === nodeId);
      const hasChildren = childEdges.length > 0;

      // 只有有子节点的节点才添加到层中（用于刷题）
      if (hasChildren) {
        // 确保层数组有足够的空间
        while (layers.length <= layer) {
          layers.push({ layer: layers.length, nodes: [] });
        }
        layers[layer].nodes.push(node);
      }

      // 添加子节点到队列
      for (const edge of childEdges) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ nodeId: edge.target, layer: layer + 1 });
        }
      }
    }

    return layers;
  }, [selectedTopLevelNode, mindMap]);

  // 深度模式：获取所有层的卡片列表（按层顺序合并）
  const depthAllCards = useMemo(() => {
    if (!selectedTopLevelNode || depthNodesByLayer.length === 0) return [];
    
    const allCards: Array<{
      parent: MindMapNode;
      children: MindMapNode[];
      layer: number;
      layerIndex: number;
    }> = [];
    
    depthNodesByLayer.forEach((layerData, layerIndex) => {
      layerData.nodes.forEach(node => {
        const childEdges = mindMap?.edges.filter(e => e.source === node.id) || [];
        const children = childEdges.map(e => {
          const childNode = mindMap?.nodes.find(n => n.id === e.target);
          return childNode || null;
        }).filter(Boolean) as MindMapNode[];

        allCards.push({
          parent: node,
          children,
          layer: layerData.layer,
          layerIndex,
        });
      });
    });
    
    return allCards;
  }, [selectedTopLevelNode, depthNodesByLayer, mindMap]);

  // 切换显示/隐藏子节点
  const handleToggleShow = useCallback(() => {
    setShowChildren(!showChildren);
  }, [showChildren]);

  // 下一个卡片（支持广度模式和深度模式）
  const handleNextCard = useCallback(() => {
    const totalCards = studyMode === 'breadth' 
      ? currentLayerCards.length 
      : depthAllCards.length;
    if (currentCardIndex < totalCards - 1) {
      setCurrentCardIndex(currentCardIndex + 1);
      setShowChildren(false);
    }
  }, [currentCardIndex, studyMode, currentLayerCards.length, depthAllCards.length]);

  // 上一个卡片
  const handlePrevCard = useCallback(() => {
    if (currentCardIndex > 0) {
      setCurrentCardIndex(currentCardIndex - 1);
      setShowChildren(false);
    }
  }, [currentCardIndex]);

  // 选择层时重置卡片索引
  useEffect(() => {
    setCurrentCardIndex(0);
    setShowChildren(false);
  }, [selectedLayer]);

  // 切换顶层节点时重置深度模式状态
  useEffect(() => {
    if (studyMode === 'depth' && selectedTopLevelNode) {
      setCurrentCardIndex(0);
      setShowChildren(false);
    }
  }, [selectedTopLevelNode, studyMode]);

  // 切换模式时重置状态
  useEffect(() => {
    setSelectedLayer(null);
    setSelectedTopLevelNode(null);
    setCurrentCardIndex(0);
    setShowChildren(false);
  }, [studyMode]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div style={{ fontSize: '18px', color: '#666' }}>加载中...</div>
      </div>
    );
  }

  if (!mindMap) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div style={{ fontSize: '18px', color: '#f44336' }}>加载失败</div>
      </div>
    );
  }

  // 深度模式：如果选择了顶层子节点，显示卡片刷题界面
  if (studyMode === 'depth' && selectedTopLevelNode) {
    const currentCard = depthAllCards[currentCardIndex];
    const totalLayers = depthNodesByLayer.length;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
        {/* 顶部工具栏 */}
        <div style={{
          padding: '10px 20px',
          background: '#f5f5f5',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <button
            onClick={() => setSelectedTopLevelNode(null)}
            style={{
              padding: '6px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#fff',
              color: '#333',
              cursor: 'pointer',
            }}
          >
            返回顶层选择
          </button>
          <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
            {mindMap.title} - {selectedTopLevelNode.text}
          </div>
        </div>

        {/* 卡片刷题区域 */}
        <div style={{ flex: 1, padding: '20px', backgroundColor: '#f5f5f5' }}>
          {currentCard ? (
            <StudyCard
              parent={currentCard.parent}
              children={currentCard.children}
              showChildren={showChildren}
              onToggleShow={handleToggleShow}
              cardIndex={currentCardIndex}
              totalCards={depthAllCards.length}
              onNext={handleNextCard}
              onPrev={handlePrevCard}
              currentLayer={currentCard.layerIndex + 1}
              totalLayers={totalLayers}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '16px', color: '#999' }}>
              没有节点
            </div>
          )}
        </div>
      </div>
    );
  }

  // 广度模式：如果选择了层，显示卡片刷题界面
  if (studyMode === 'breadth' && selectedLayer !== null) {
    const currentCard = currentLayerCards[currentCardIndex];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
        {/* 顶部工具栏 */}
        <div style={{
          padding: '10px 20px',
          background: '#f5f5f5',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <button
            onClick={() => setSelectedLayer(null)}
            style={{
              padding: '6px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#fff',
              color: '#333',
              cursor: 'pointer',
            }}
          >
            返回层选择
          </button>
          <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
            {mindMap.title} - 第 {selectedLayer + 1} 层
          </div>
        </div>

        {/* 卡片刷题区域 */}
        <div style={{ flex: 1, padding: '20px', backgroundColor: '#f5f5f5' }}>
          {currentCard ? (
            <StudyCard
              parent={currentCard.parent}
              children={currentCard.children}
              showChildren={showChildren}
              onToggleShow={handleToggleShow}
              cardIndex={currentCardIndex}
              totalCards={currentLayerCards.length}
              onNext={handleNextCard}
              onPrev={handlePrevCard}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '16px', color: '#999' }}>
              该层没有节点
            </div>
          )}
        </div>
      </div>
    );
  }

  // 显示层选择界面
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
      {/* 顶部工具栏 */}
      <div style={{
        padding: '10px 20px',
        background: '#f5f5f5',
        borderBottom: '1px solid #ddd',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <a
          href={(() => {
            const domainId = (window as any).UiContext?.domainId || '';
            return domainId ? `/d/${domainId}/mindmap/${docId}` : `/mindmap/${docId}`;
          })()}
          style={{
            padding: '6px 12px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            color: '#333',
            textDecoration: 'none',
            cursor: 'pointer',
          }}
        >
          返回思维导图
        </a>
        <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
          {mindMap.title} - 刷题模式
        </div>
      </div>

      {/* 模式选择 */}
      <div style={{ padding: '20px', borderBottom: '1px solid #ddd', background: '#fff' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span style={{ fontSize: '16px', fontWeight: '600', color: '#333' }}>刷题模式：</span>
          <button
            onClick={() => setStudyMode('breadth')}
            style={{
              padding: '8px 16px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: studyMode === 'breadth' ? '#2196f3' : '#fff',
              color: studyMode === 'breadth' ? '#fff' : '#333',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            广度模式
          </button>
          <button
            onClick={() => setStudyMode('depth')}
            style={{
              padding: '8px 16px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: studyMode === 'depth' ? '#2196f3' : '#fff',
              color: studyMode === 'depth' ? '#fff' : '#333',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            深度模式
          </button>
        </div>
      </div>

      {/* 层选择区域 */}
      <div style={{ flex: 1, padding: '40px', overflow: 'auto', backgroundColor: '#f5f5f5' }}>
        {studyMode === 'breadth' && (
          <>
            <h2 style={{ marginBottom: '30px', fontSize: '24px', fontWeight: '600', color: '#333' }}>
              选择要刷题的层
            </h2>
            {nodesByLayer.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#999', fontSize: '16px' }}>
                暂无可刷题的层
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: '20px',
              }}>
                {nodesByLayer.map((layer, index) => (
                  <div
                    key={index}
                    onClick={() => setSelectedLayer(index)}
                    style={{
                      padding: '24px',
                      border: '2px solid #2196F3',
                      borderRadius: '12px',
                      background: '#fff',
                      cursor: 'pointer',
                      transition: 'all 0.3s',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-4px)';
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
                    }}
                  >
                    <div style={{ fontSize: '20px', fontWeight: '600', color: '#2196F3', marginBottom: '12px' }}>
                      第 {index + 1} 层
                    </div>
                    <div style={{ fontSize: '16px', color: '#666', marginBottom: '8px' }}>
                      {layer.nodes.length} 个节点
                    </div>
                    <div style={{ fontSize: '14px', color: '#999', marginTop: '12px' }}>
                      点击开始刷题 →
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {studyMode === 'depth' && selectedTopLevelNode === null && (
          <>
            <h2 style={{ marginBottom: '30px', fontSize: '24px', fontWeight: '600', color: '#333' }}>
              选择顶层子节点开始深度刷题
            </h2>
            {topLevelNodes.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#999', fontSize: '16px' }}>
                暂无顶层子节点
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: '20px',
              }}>
                {topLevelNodes.map((node) => {
                  const childEdges = mindMap.edges.filter(e => e.source === node.id);
                  const hasChildren = childEdges.length > 0;
                  return (
                    <div
                      key={node.id}
                      onClick={() => hasChildren && setSelectedTopLevelNode(node)}
                      style={{
                        padding: '24px',
                        border: '2px solid #2196F3',
                        borderRadius: '12px',
                        background: hasChildren ? '#fff' : '#f5f5f5',
                        cursor: hasChildren ? 'pointer' : 'not-allowed',
                        transition: 'all 0.3s',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                        opacity: hasChildren ? 1 : 0.6,
                      }}
                      onMouseEnter={(e) => {
                        if (hasChildren) {
                          e.currentTarget.style.transform = 'translateY(-4px)';
                          e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (hasChildren) {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
                        }
                      }}
                    >
                      <div style={{ fontSize: '20px', fontWeight: '600', color: '#2196F3', marginBottom: '12px' }}>
                        {node.text || '未命名节点'}
                      </div>
                      <div style={{ fontSize: '16px', color: '#666', marginBottom: '8px' }}>
                        {hasChildren ? `${childEdges.length} 个子节点` : '无子节点'}
                      </div>
                      {hasChildren && (
                        <div style={{ fontSize: '14px', color: '#999', marginTop: '12px' }}>
                          点击开始刷题 →
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const page = new NamedPage('mindmap_study', async () => {
  try {
    const $container = $('#mindmap-study');
    if (!$container.length) {
      return;
    }

    ReactDOM.render(
      <MindMapStudy />,
      $container[0]
    );
  } catch (error: any) {
    console.error('Failed to initialize mindmap study:', error);
    Notification.error('初始化刷题页面失败: ' + (error.message || '未知错误'));
  }
});

export default page;


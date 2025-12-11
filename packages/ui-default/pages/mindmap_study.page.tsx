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

interface Problem {
  imageUrl?: string; // 题目图片URL
  imageNote?: string; // 图片备注
  pid: string;
  type: 'single';
  stem: string;
  options: string[];
  answer: number;
  analysis?: string;
  cardId: string;
  cardTitle: string;
  cardUrl: string;
}

interface Unit {
  node: MindMapNode;
  problemCount: number;
  problems: Problem[];
}

function MindMapStudy() {
  const [mindMap, setMindMap] = useState<MindMapDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [units, setUnits] = useState<Unit[]>([]);
  const [selectedUnitNodeId, setSelectedUnitNodeId] = useState<string | null>(null);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);

  // 从 URL 获取 docId
  const docId = useMemo(() => {
    const pathParts = window.location.pathname.split('/').filter(p => p);
    const mindmapIndex = pathParts.indexOf('mindmap');
    if (mindmapIndex >= 0 && mindmapIndex < pathParts.length - 1) {
      return pathParts[mindmapIndex + 1];
    }
    return '';
  }, []);

  // 从 UiContext 加载思维导图数据和 unit 列表
  useEffect(() => {
    const uiContext = (window as any).UiContext;
    if (!uiContext) {
      Notification.error('UiContext 未找到');
        setLoading(false);
        return;
      }

      try {
      // 从 UiContext 获取数据
      const mindMapData = uiContext.mindMap;
      const unitsData = uiContext.units || [];

      if (mindMapData) {
        setMindMap(mindMapData);
        setUnits(unitsData);
      } else {
        Notification.error('思维导图数据未找到');
      }
      } catch (error: any) {
        Notification.error('加载思维导图失败: ' + (error.message || '未知错误'));
      } finally {
        setLoading(false);
      }
  }, []);


  // 点击选项立即提交并显示答案
  const handleOptionClick = useCallback((problemIndex: number, optionIndex: number) => {
    setSelectedAnswer(optionIndex);
    setShowAnswer(true);
  }, []);

  // 下一个题目
  const handleNextProblem = useCallback(() => {
    const selectedUnit = units.find(u => u.node.id === selectedUnitNodeId);
    if (selectedUnit && currentProblemIndex < selectedUnit.problems.length - 1) {
      setCurrentProblemIndex(currentProblemIndex + 1);
      setSelectedAnswer(null);
      setShowAnswer(false);
    }
  }, [currentProblemIndex, units, selectedUnitNodeId]);

  // 上一个题目
  const handlePrevProblem = useCallback(() => {
    if (currentProblemIndex > 0) {
      setCurrentProblemIndex(currentProblemIndex - 1);
      setSelectedAnswer(null);
      setShowAnswer(false);
    }
  }, [currentProblemIndex]);

  // 点击 unit 进入刷题页面
  const handleUnitClick = useCallback((unit: Unit) => {
    setSelectedUnitNodeId(unit.node.id);
    setCurrentProblemIndex(0);
    setSelectedAnswer(null);
    setShowAnswer(false);
  }, []);

  // 当题目索引变化时，立即清除选择状态
  useEffect(() => {
    setSelectedAnswer(null);
    setShowAnswer(false);
  }, [currentProblemIndex]);

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

  // 如果选择了 unit，显示刷题界面
  if (selectedUnitNodeId) {
    const selectedUnit = units.find(u => u.node.id === selectedUnitNodeId);
    const currentProblem = selectedUnit?.problems[currentProblemIndex];
    
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
            onClick={() => {
              setSelectedUnitNodeId(null);
              setCurrentProblemIndex(0);
              setSelectedAnswer(null);
              setShowAnswer(false);
            }}
            style={{
              padding: '6px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#fff',
              color: '#333',
              cursor: 'pointer',
            }}
          >
            返回 unit 列表
          </button>
          <div style={{ marginLeft: 'auto', fontSize: '14px', color: '#666' }}>
            {mindMap.title} - {selectedUnit?.node.text || '刷题'}
          </div>
        </div>

        {/* 题目刷题区域 */}
        <div style={{ flex: 1, padding: '20px', backgroundColor: '#f5f5f5', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
          {currentProblem ? (
            <div style={{ width: '100%', maxWidth: '800px' }}>
              <div style={{ marginBottom: '20px', fontSize: '14px', color: '#666', textAlign: 'center' }}>
                {currentProblemIndex + 1} / {selectedUnit?.problems.length || 0}
            </div>
              
              <div style={{
                width: '100%',
                minHeight: '400px',
                border: '2px solid #2196F3',
                borderRadius: '12px',
                padding: '30px',
                background: '#fff',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              }}>
                {/* 题干 */}
                <div style={{ fontSize: '18px', fontWeight: '600', color: '#333', marginBottom: '30px', lineHeight: '1.6' }}>
                  {currentProblem.stem}
                </div>
                
                {/* 题目图片（题干下方，选项上方） */}
                {currentProblem.imageUrl && (
                  <div style={{ marginBottom: '30px', textAlign: 'center' }}>
                    <img
                      src={currentProblem.imageUrl}
                      alt="题目图片"
                      onClick={async () => {
                        try {
                          const previewImage = (window as any).Ejunz?.components?.preview?.previewImage;
                          if (previewImage) {
                            await previewImage(currentProblem.imageUrl!);
                          } else {
                            // 使用InfoDialog显示图片
                            const { InfoDialog } = await import('vj/components/dialog/index');
                            const $ = (await import('jquery')).default;
                            const dialog = new InfoDialog({
                              $body: $(`<div class="typo"><img src="${currentProblem.imageUrl}" style="max-height: calc(80vh - 45px);"></img></div>`),
                            });
                            await dialog.open();
                          }
                        } catch (error) {
                          console.error('预览图片失败:', error);
                          Notification.error('预览图片失败');
                        }
                      }}
                      style={{
                        maxWidth: '100%',
                        maxHeight: '400px',
                        cursor: 'pointer',
                        borderRadius: '8px',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                      }}
                    />
                    {/* 图片备注（显示在图片下方） */}
                    {currentProblem.imageNote && (
                      <div style={{
                        marginTop: '12px',
                        fontSize: '14px',
                        color: '#666',
                        lineHeight: '1.5',
                        fontStyle: 'italic',
                      }}>
                        {currentProblem.imageNote}
                      </div>
                    )}
                  </div>
                )}
                
                {/* 选项 */}
                <div style={{ marginBottom: '30px' }}>
                  {currentProblem.options.map((option, index) => {
                    const isSelected = selectedAnswer === index;
                    const isCorrect = index === currentProblem.answer;
                    
                    let optionStyle: React.CSSProperties = {
                      padding: '15px 20px',
                      marginBottom: '12px',
                      borderRadius: '8px',
                      border: '2px solid #ddd',
                      background: '#fff',
                      cursor: showAnswer ? 'default' : 'pointer',
                      fontSize: '16px',
                      lineHeight: '1.6',
                      transition: 'all 0.2s',
                    };
                    
                    if (showAnswer) {
                      if (isCorrect) {
                        optionStyle.borderColor = '#4caf50';
                        optionStyle.background = '#e8f5e9';
                        optionStyle.color = '#2e7d32';
                      } else if (isSelected && !isCorrect) {
                        optionStyle.borderColor = '#f44336';
                        optionStyle.background = '#ffebee';
                        optionStyle.color = '#c62828';
                      }
                    } else if (isSelected) {
                      optionStyle.borderColor = '#2196F3';
                      optionStyle.background = '#e3f2fd';
                    }
                    
    return (
                      <div
                        key={`problem-${currentProblemIndex}-option-${index}`}
                        onClick={() => !showAnswer && handleOptionClick(currentProblemIndex, index)}
                        style={optionStyle}
                      >
                        <span style={{ fontWeight: '600', marginRight: '10px' }}>
                          {String.fromCharCode(65 + index)}.
                        </span>
                        {option}
                        {showAnswer && isCorrect && (
                          <span style={{ marginLeft: '10px', color: '#4caf50', fontWeight: '600' }}>✓ 正确答案</span>
                        )}
                        {showAnswer && isSelected && !isCorrect && (
                          <span style={{ marginLeft: '10px', color: '#f44336', fontWeight: '600' }}>✗ 错误</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                
                {/* 显示答案和解析 */}
                {showAnswer && (
                  <>
                    {/* 结果提示 */}
        <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      borderRadius: '8px',
                      fontSize: '16px',
                      fontWeight: '600',
                      textAlign: 'center',
                      background: selectedAnswer === currentProblem.answer ? '#e8f5e9' : '#ffebee',
                      color: selectedAnswer === currentProblem.answer ? '#2e7d32' : '#c62828',
                    }}>
                      {selectedAnswer === currentProblem.answer ? '✓ 回答正确！' : '✗ 回答错误'}
                    </div>
                    
                    {/* 解析 */}
                    {currentProblem.analysis && (
                      <div style={{
                        marginTop: '20px',
                        padding: '15px',
          background: '#f5f5f5',
                        borderRadius: '8px',
                        fontSize: '14px',
                        color: '#666',
                        lineHeight: '1.6',
                      }}>
                        <div style={{ fontWeight: '600', marginBottom: '8px', color: '#333' }}>解析：</div>
                        {currentProblem.analysis}
                      </div>
                    )}
                    
                    {/* 卡片链接 */}
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      background: '#e3f2fd',
                      borderRadius: '8px',
                      fontSize: '14px',
                    }}>
                      <div style={{ fontWeight: '600', marginBottom: '8px', color: '#333' }}>来源卡片：</div>
                      <a 
                        href={currentProblem.cardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ 
                          color: '#2196F3', 
                          textDecoration: 'none',
                          fontSize: '16px',
                          fontWeight: '500',
                        }}
                      >
                        {currentProblem.cardTitle} →
                      </a>
                    </div>
                  </>
                )}
              </div>
              
              {/* 控制按钮 */}
              <div style={{ marginTop: '30px', display: 'flex', gap: '10px', justifyContent: 'center' }}>
          <button
                  onClick={handlePrevProblem}
                  disabled={currentProblemIndex === 0}
            style={{
                    padding: '12px 24px',
              border: '1px solid #ddd',
              borderRadius: '4px',
                    background: currentProblemIndex === 0 ? '#f5f5f5' : '#fff',
                    color: currentProblemIndex === 0 ? '#999' : '#333',
                    cursor: currentProblemIndex === 0 ? 'not-allowed' : 'pointer',
                    fontSize: '16px',
            }}
          >
                  上一题
          </button>
                <button
                  onClick={handleNextProblem}
                  disabled={currentProblemIndex >= (selectedUnit?.problems.length || 0) - 1}
                  style={{
                    padding: '12px 24px',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    background: currentProblemIndex >= (selectedUnit?.problems.length || 0) - 1 ? '#f5f5f5' : '#4caf50',
                    color: currentProblemIndex >= (selectedUnit?.problems.length || 0) - 1 ? '#999' : '#fff',
                    cursor: currentProblemIndex >= (selectedUnit?.problems.length || 0) - 1 ? 'not-allowed' : 'pointer',
                    fontSize: '16px',
                  }}
                >
                  下一题
                </button>
          </div>
        </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '16px', color: '#999' }}>
              没有题目
            </div>
          )}
        </div>
      </div>
    );
  }

  // 显示 unit 列表界面
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
            const domainId = (window as any).UiContext?.domainId || 'system';
            return `/d/${domainId}/mindmap/${docId}`;
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

      {/* Unit 列表区域 */}
      <div style={{ flex: 1, padding: '40px', overflow: 'auto', backgroundColor: '#f5f5f5' }}>
            <h2 style={{ marginBottom: '30px', fontSize: '24px', fontWeight: '600', color: '#333' }}>
          选择 Unit 开始刷题
            </h2>
        {units.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#999', fontSize: '16px' }}>
            暂无可刷题的 Unit
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: '20px',
              }}>
            {units.map((unit) => (
                  <div
                key={unit.node.id}
                onClick={() => handleUnitClick(unit)}
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
                  {unit.node.text || '未命名 Unit'}
                    </div>
                    <div style={{ fontSize: '16px', color: '#666', marginBottom: '8px' }}>
                  {unit.problemCount} 道题目
                    </div>
                    <div style={{ fontSize: '14px', color: '#999', marginTop: '12px' }}>
                      点击开始刷题 →
                    </div>
                  </div>
                ))}
              </div>
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


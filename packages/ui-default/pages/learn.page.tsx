import React, { useState, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  MarkerType,
  Position,
  Handle,
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css';

interface Card {
  id: string;
  title: string;
  cardId: string;
  cardDocId: string;
  order?: number;
}

interface MindMapNode {
  id: string;
  text: string;
  level?: number;
  order?: number;
  cards?: Card[];
  children?: MindMapNode[];
}

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction: string = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 100, ranksep: 150 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 200, height: 100 });
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
        x: nodeWithPosition.x - 100,
        y: nodeWithPosition.y - 50,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

const CustomNode = ({ data }: { data: any }) => {
  const node = data.originalNode as MindMapNode;
  const cards = node.cards || [];
  const hasCards = cards.length > 0;

  return (
    <div
      style={{
        padding: '12px',
        borderRadius: '8px',
        backgroundColor: '#fff',
        border: '2px solid #2196f3',
        minWidth: '180px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div
        style={{
          fontWeight: 'bold',
          marginBottom: '8px',
          fontSize: '14px',
          color: '#333',
        }}
      >
        {node.text || i18n('Unnamed Node')}
      </div>
      {hasCards && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
          {cards.length} {i18n('cards')}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
};

const nodeTypes = {
  mindmap: CustomNode,
};

function LearnPage() {
  const nodesData = (window.UiContext?.nodes || []) as MindMapNode[];
  const domainId = window.UiContext?.domainId as string;
  const mindMapDocId = window.UiContext?.mindMapDocId as string;


  const buildFlowData = useCallback((treeNodes: MindMapNode[]): { nodes: Node[]; edges: Edge[] } => {
    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];
    let nodeCounter = 0;

    const processNode = (node: MindMapNode, parentId?: string, level: number = 0) => {
      const flowNode: Node = {
        id: node.id,
        type: 'mindmap',
        position: { x: 0, y: 0 },
        data: {
          originalNode: node,
          domainId,
          mindMapDocId,
        },
      };
      flowNodes.push(flowNode);

      if (parentId) {
        flowEdges.push({
          id: `edge-${parentId}-${node.id}`,
          source: parentId,
          target: node.id,
          type: 'smoothstep',
          markerEnd: {
            type: MarkerType.ArrowClosed,
          },
          style: {
            stroke: '#2196f3',
            strokeWidth: 2,
          },
        });
      }

      if (node.children) {
        node.children.forEach((child) => {
          processNode(child, node.id, level + 1);
        });
      }
    };

    treeNodes.forEach((rootNode) => {
      processNode(rootNode);
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [domainId, mindMapDocId]);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    if (!nodesData || nodesData.length === 0) {
      return { nodes: [], edges: [] };
    }
    const flowData = buildFlowData(nodesData);
    return getLayoutedElements(flowData.nodes, flowData.edges, 'TB');
  }, [nodesData, buildFlowData]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  React.useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const originalNode = node.data.originalNode as MindMapNode;
    const cards = originalNode.cards || [];
    
    if (cards.length > 0) {
      const sortedCards = [...cards].sort((a, b) => (a.order || 0) - (b.order || 0));
      const firstCard = sortedCards[0];
      window.location.href = `/learn/lesson/${domainId}/${originalNode.id}/${firstCard.cardDocId}`;
    } else {
      window.location.href = `/mindmap/node/${originalNode.id}`;
    }
  }, [domainId]);

  if (!nodesData || nodesData.length === 0) {
    return (
      <div style={{
        padding: '40px',
        textAlign: 'center',
        color: '#666',
        minHeight: '200px',
      }}>
        <p>{i18n('No nodes available.')}</p>
        <p style={{ fontSize: '14px', marginTop: '10px', color: '#999' }}>
          {i18n('Please create a mindmap first.')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnDrag={true}
        zoomOnScroll={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

const page = new NamedPage('learnPage', async () => {
  try {
    const container = document.getElementById('learn-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<LearnPage />, container);
  } catch (error: any) {
  }
});

export default page;

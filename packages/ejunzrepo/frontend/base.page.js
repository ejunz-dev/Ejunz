import $ from 'jquery';
import * as d3 from 'd3';
import {
  AutoloadPage,
  addPage
} from '@ejunz/ui-default';

addPage(new AutoloadPage('base_domain', async () => {
  const raw = UiContext.forceGraphData;
  if (!raw || !raw.nodes) {
    d3.select("#d3-base")
      .append("text")
      .attr("x", 20)
      .attr("y", 40)
      .style("fill", "#888")
      .style("font-size", "16px")
      .text("📦 暂无仓库数据，请先创建一个仓库节点");
    return;
  }

  const nodes = raw.nodes.filter(n => n.type === 'repo');
  const width = 1000;
  const height = 800;
  const padding = 60;
  const cols = 5;
  const cellSize = 160;

  const svg = d3.select("#d3-base")
    .attr("viewBox", [0, 0, width, height])
    .attr("width", "100%")
    .attr("height", height)
    .attr("preserveAspectRatio", "xMidYMid meet");
  svg.selectAll("*").remove();

  const gContainer = svg.append("g");

  nodes.forEach((node, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    node.gridX = padding + col * cellSize;
    node.gridY = padding + row * cellSize;
    node.x = node.gridX + Math.random() * 50;
    node.y = node.gridY + Math.random() * 50;
  });

  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    const col = i % cols;
    const down = i + cols;
    const right = i + 1;
    if (col < cols - 1 && right < nodes.length) {
      links.push({ source: nodes[i], target: nodes[right] });
    }
    if (down < nodes.length) {
      links.push({ source: nodes[i], target: nodes[down] });
    }
  }

  const simulation = d3.forceSimulation(nodes)
  .force("x", d3.forceX(d => d.gridX).strength(0.15))
  .force("y", d3.forceY(d => d.gridY).strength(0.15))
  .force("collide", d3.forceCollide(35))
  .force("link", d3.forceLink(links).distance(cellSize).strength(0.05))
  .alpha(0.9)
  .alphaDecay(0.03)
  .on("tick", ticked)


  const drag = d3.drag()
    .on("start", (event, d) => {
      if (!event.active) simulation.alphaTarget(0.6).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) simulation.alphaTarget(0.1);
      d.fx = null;
      d.fy = null;
    });

  const link = gContainer.append("g")
    .attr("stroke", "#666")
    .attr("stroke-opacity", 0.3)
    .selectAll("line")
    .data(links)
    .join("line");

  const node = gContainer.append("g")
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    .attr("r", 10)
    .attr("fill", "#00BFFF")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .call(drag);

  const label = gContainer.append("g")
    .selectAll("text")
    .data(nodes)
    .join("text")
    .text(d => d.name)
    .attr("font-size", "12px")
    .attr("dy", "-1.2em")
    .attr("text-anchor", "middle")
    .attr("fill", "green")
    .style("pointer-events", "auto")
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      if (!d.url) return;
      const isNewTab = event.ctrlKey || event.metaKey || event.button === 1;
      if (isNewTab) {
        window.open(d.url, '_blank');
      } else {
        window.location.href = d.url;
      }
    });

  function ticked() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    node
      .attr("cx", d => d.x)
      .attr("cy", d => d.y);

    label
      .attr("x", d => d.x)
      .attr("y", d => d.y);
  }

  const zoom = d3.zoom()
  .scaleExtent([0.3, 3])
  .on("zoom", event => gContainer.attr("transform", event.transform));

    svg.call(zoom);

    svg.call(
    zoom.transform,
    d3.zoomIdentity.translate(width / 2, height / 2).scale(0.3)
    );


  function centerGraph() {
    const xExtent = d3.extent(nodes, d => d.x);
    const yExtent = d3.extent(nodes, d => d.y);
    const graphWidth = xExtent[1] - xExtent[0];
    const graphHeight = yExtent[1] - yExtent[0];

    const scale = Math.min(width / (graphWidth + 100), height / (graphHeight + 100), 1.5);
    const tx = (width - graphWidth * scale) / 2 - xExtent[0] * scale;
    const ty = (height - graphHeight * scale) / 2 - yExtent[0] * scale;

    svg.transition().duration(800).call(
      zoom.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }
    const xExtent = d3.extent(nodes, d => d.x);
    const yExtent = d3.extent(nodes, d => d.y);
    const graphWidth = xExtent[1] - xExtent[0];
    const graphHeight = yExtent[1] - yExtent[0];
    const graphCenterX = xExtent[0] + graphWidth / 2;
    const graphCenterY = yExtent[0] + graphHeight / 2;

    const initialScale = 0.2;
    const initialTx = width / 2 - graphCenterX * initialScale;
    const initialTy = height / 2 - graphCenterY * initialScale;

    svg.call(
    zoom.transform,
    d3.zoomIdentity.translate(initialTx, initialTy).scale(initialScale)
    );

    setTimeout(centerGraph, 500);

}));

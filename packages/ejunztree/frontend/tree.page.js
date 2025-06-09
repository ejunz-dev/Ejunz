import $ from 'jquery';
import * as d3 from 'd3';
import {
  AutoloadPage,
  addPage
} from '@ejunz/ui-default';
addPage(new AutoloadPage('tree_detail,tree_map', async () => {
    const data = UiContext.d3TreeData;
    if (!data) return;
  
    const dx = 80;   // 垂直方向每层间距
    const dy = 180;  // 水平方向兄弟节点间距
  
    const svg = d3.select("#d3-tree");
    svg.selectAll("*").remove();
  
    const root = d3.hierarchy(data);
    const treeLayout = d3.tree()
    .nodeSize([dx, dy])
    .separation((a, b) => (a.parent === b.parent ? 1.2 : 2));
    treeLayout(root);

  
    // 自动计算尺寸范围
    const x0 = d3.min(root.descendants(), d => d.x);
    const x1 = d3.max(root.descendants(), d => d.x);
    const y0 = 0;
    const y1 = d3.max(root.descendants(), d => d.y);
  
    const padding = 60;
  
    const width = x1 - x0 + padding * 2;
    const height = y1 + padding * 2;
  
    svg
    .attr("viewBox", [x0 - padding, -y1 - padding, width, height])
    .attr("width", "100%")
    .attr("height", height + 100)  
    .attr("preserveAspectRatio", "xMidYMid meet");
  
    const g = svg.append("g");
  
    // 连接线（竖向）
    g.selectAll(".link")
      .data(root.links())
      .enter()
      .append("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", "#ccc")
      .attr("stroke-width", 1.5)
      .attr("d", d3.linkVertical()
        .x(d => d.x)
        .y(d => -d.y)
      );
  
    // 节点
    const node = g.selectAll(".node")
      .data(root.descendants())
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", d => `translate(${d.x},${-d.y})`);
  
    node.append("circle")
      .attr("r", 5)
      .attr("fill", "#4682B4");
  
    node.append("text")
    .attr("dy", "-0.8em")
    .attr("text-anchor", "middle")
    .text(d => d.data.name)
    .style("fill", d => `hsl(210, 80%, ${Math.min(30 + d.depth * 10, 70)}%)`)
    .style("font-size", "12px")
    .style("cursor", "pointer")
    .on("click", (event, d) => {
        if (!d.data.url) return;

        const isNewTab = event.ctrlKey || event.metaKey || event.button === 1;
        if (isNewTab) {
        window.open(d.data.url, '_blank');
        } else {
        window.location.href = d.data.url;
        }
    })
    .on("mousedown", function(event) {
        // 阻止中键拖拽行为
        if (event.button === 1) event.preventDefault();
    })
    .on("mouseover", function () {
        d3.select(this).style("font-weight", "bold");
    })
    .on("mouseout", function () {
        d3.select(this).style("font-weight", "normal");
    });

            
  }));
  